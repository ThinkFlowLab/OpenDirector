"""Bounded tool loop; protocol reasoning stays in private project run records."""

import asyncio
from copy import deepcopy
import json
import re
from pathlib import Path
from uuid import UUID, uuid5

import anyio

from museshow.domain.input_rules import MAX_REFERENCES, VideoMode, input_rules
from museshow.agent.video_edits import video_edit_request, preserve_video_edit

from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator

from museshow.domain.projects import ProjectError
from museshow.domain.canvas import NodeKind
from museshow.domain.references import ReferenceContent, project_content
from museshow.domain.storyboard import RETIRED_SHOT_FIELDS
from museshow.infrastructure.local_projects import child, read_json, write_json
from museshow.infrastructure.storyboard import StoryboardProjects
from museshow.integrations.chat_completions import chat_payload
from museshow.agent.prompts import SYSTEM_PROMPT
from museshow.agent import production_tools, storyboard_tools
from museshow.domain.production import ProductionRequest



def argument_error(failure):
    """Name the rejected fields so the model can correct its next call; never echo values."""
    if not isinstance(failure, ValidationError):
        return "工具参数或文本格式无效，未执行。"
    problems = "；".join(f"{'.'.join(map(str, item['loc'])) or '参数'}：{item['msg']}"
                         for item in failure.errors(include_input=False, include_url=False)[:5])
    return f"工具参数无效，未执行（{problems}）。请只使用工具定义中的字段并修正后重试。"

class Arguments(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Empty(Arguments):
    pass


class ReadText(Arguments):
    assetId: UUID


class SaveText(Arguments):
    name: str = Field(min_length=1, max_length=255)
    text: str = Field(max_length=1024 * 1024)
    nodeId: UUID | None = None
    expectedRevision: int | None = Field(default=None, ge=1, description="修改已有节点时必须填写 read_project 返回的节点版本；新增时省略")


class Generate(Arguments):
    videoMode: VideoMode | None = Field(default=None, description='省略时新节点按所选模型决定默认模式，已有节点保留原模式；reference 支持的图片、视频及音频参考以该模型 inputRules 为准；continuation 接续 referenceIds 中一段由同一 vLLM-Omni MiniMax-H3 服务生成的视频，画面和声音连续')
    promptContent: ReferenceContent | None = Field(default=None, description="可选的正文引用片段。需要明确参考位置时填写 text/reference 片段，reference 使用实际 assetId、名称；据此生成 prompt 和去重 referenceIds。音频仅朗读 text。")
    kind: NodeKind
    name: str = Field(default="", max_length=200, description="素材的可读名称，包含镜头序号和用途，例如 03 推门出街｜视频")
    prompt: str = Field(min_length=1, max_length=20000, description="生成要求；audio 时必须仅为该镜头需要朗读的正文，不包含音色、风格、编号或制作说明")
    referenceIds: list[UUID] = Field(default_factory=list, max_length=MAX_REFERENCES)
    nodeId: UUID | None = None
    expectedRevision: int | None = Field(default=None, ge=1, description="修改已有节点时必须填写 read_project 返回的节点版本；新增时省略")

    @model_validator(mode='after')
    def inline_references(self):
        if self.promptContent is not None:
            self.prompt, ids = project_content(self.promptContent, speech=self.kind == 'audio')
            self.referenceIds = [UUID(value) for value in dict.fromkeys([*ids, *map(str, self.referenceIds or [])])]
            if len(self.referenceIds) > MAX_REFERENCES:
                raise ValueError(f'参考数量超过系统上限 {MAX_REFERENCES}')
        return self


class ReadTask(Arguments):
    taskId: UUID


SCHEMAS = {"read_project": (Empty, "读取最新画布、资产、任务与当前可用模型。"),
           "read_text_asset": (ReadText, "读取当前项目中的文本资产，最多 64 KB。"),
           "save_text_asset": (SaveText, "按用户要求将剧本、分镜文本或其他文字保存为画布资产，名称以 .md 或 .txt 结尾。"),
           "generate_asset": (Generate, "按用户要求调用已选择的模型生成资产；媒体任务在后台运行，返回提交记录。"),
           "get_generation_task": (ReadTask, "查询一次生成任务的状态和输出资产，不连续轮询。")}
SCHEMAS.update(storyboard_tools.SCHEMAS)
SCHEMAS.update(production_tools.SCHEMAS)
SCHEMAS["start_production_plan"] = (ProductionRequest, "用户明确要求制作多镜短片或为已有镜头批量补充素材时提交有限制作计划。已有镜头填写 shotId 和 expectedRevision，可只填 narration 补旁白，保留画面与原声；后台完成生成及采用，无需逐条生成再采用。引用已保存剧本的资产 ID 和 fingerprint，不另传剧本正文。最多12镜，仅讨论方案时不要调用。")
TOOLS = [{"type": "function", "function": {"name": name, "description": description, "parameters": schema.model_json_schema()}} for name, (schema, description) in SCHEMAS.items()]


class AgentLoop:
    def __init__(self, store, configs, generation, provider):
        self.store, self.configs, self.generation, self.provider = store, configs, generation, provider
        self.canvas = generation.canvas
        self.storyboard = StoryboardProjects(store)
        self.production = None

    def _run_file(self, directory, turn_id):
        return child(child(directory, "agent-runs"), turn_id + ".json")

    def _save(self, turn, run):
        with self.store.transaction() as db:
            directory = self.store._owner(db, turn.owner)
            if str(directory) != turn.directory:
                raise ProjectError("项目目录已变化，执行记录未写入其他位置。", 409)
            path = self._run_file(directory, turn.id)
            path.parent.mkdir(exist_ok=True)
            write_json(path, run)

    def _context(self, turn):
        # Previous tool cycles retain reasoning_content for DeepSeek thinking mode.
        # Historical messages from before tool support become quoted context rather
        # than fabricated assistant protocol messages with missing reasoning.
        context = []
        history = turn.conversation["messages"][:-2][-20:]
        for item in history:
            if item.get("source") != "model" or not item["text"]:
                continue
            if item["role"] == "user":
                text = project_content(item['content'])[0] if item.get('content') is not None else item['text']
                if item['assets']:
                    text += '\n历史引用对应（不代表当前可再次使用）：' + json.dumps([
                        {'reference': index, 'assetId': asset['id'], 'name': asset['name'],
                         'transmission': next((entry['transmission'] for entry in item.get('referenceInputs', []) if entry['assetId'] == asset['id']), 'historical_context')}
                        for index, asset in enumerate(item['assets'], 1)], ensure_ascii=False)
                context.append({"role": "user", "content": text})
            else:
                path = self._run_file(Path(turn.directory), item["id"])
                old = read_json(path) if path.exists() else None
                if old and old.get("status") == "complete" and isinstance(old.get("protocol"), list):
                    context.extend(old["protocol"])
                else:
                    context.append({"role": "user", "content": "此前助手的回复（历史上下文）：\n" + item["text"]})
        snapshot = self._project(turn)
        context.append({"role": "user", "content": "当前项目状态（数据）：\n" + json.dumps(snapshot, ensure_ascii=False)})
        context.append(turn.payload["messages"][-1])
        return [{"role": "system", "content": SYSTEM_PROMPT}, *context]

    def _project(self, turn):
        snapshot = self.canvas.snapshot(turn.owner)
        board = self.storyboard.snapshot(turn.owner)["storyboard"]
        selected_shot = next((shot for shot in board["shots"] if shot["id"] == turn.selected_shot_id), None)
        selected = next((node for node in snapshot["canvas"]["nodes"] if node["id"] == turn.selected_node_id), None)
        plans = self.production.list(turn.owner) if self.production else []
        progress = self.production.progress(turn.owner, plans) if self.production else {'delivery': None, 'plans': []}
        progress_by_id = {item['planId']: item for item in progress['plans']}
        def priority(plan):
            if any(step['nodeId'] == turn.selected_node_id for step in plan['steps']):
                return 0
            if any(shot['id'] == turn.selected_shot_id for shot in plan['shots']):
                return 1
            return 2 if plan['status'] != 'succeeded' else 3
        visible = sorted(plans, key=priority)[:10]
        return {"productionPlans": [production_tools.summary(plan, progress_by_id[plan['id']]) for plan in visible],
                'productionDelivery': progress['delivery'],
                'productionPlanCount': len(plans), 'productionPlansTruncated': len(visible) < len(plans),
                'videoEditRequest': video_edit_request(turn),
                'modelSelections': turn.selections, "selectedNodeId": turn.selected_node_id,
                "selectedShot": {key: value for key, value in selected_shot.items() if key not in RETIRED_SHOT_FIELDS} if selected_shot else None,
                "storyboardRevision": board["revision"], "orderRevision": board["orderRevision"],
                "shots": [{key: val for key, val in shot.items() if key not in RETIRED_SHOT_FIELDS} for shot in board["shots"]],
                "selectedInput": {"prompt": selected["prompt"], "draftPreview": (selected["draft"] or "")[:8192]} if selected else None,
                "nodes": [{key: node[key] for key in ("id", "kind", "role", "title", "assetId", "referenceIds", "videoMode", "taskId", "revision")} for node in snapshot["canvas"]["nodes"]],
                "assets": [{key: asset[key] for key in ("id", "name", "kind", "purpose", "fingerprint", "referenceIds", "generationTaskId", "productionPlanId", "productionStepId", "shotId")} for asset in snapshot["assets"] if asset["id"] in snapshot["availableAssetIds"]],
                "availableAssetIds": snapshot["availableAssetIds"],
                "tasks": [production_tools.task_summary(task, include_inputs=False) for task in snapshot["tasks"][-20:]],
                "models": [{key: model[key] for key in ("id", "kind", "modelId", "inputRules")} for model in self.configs.list()]}

    async def execute(self, turn, name, value, operation_id):
        history = getattr(turn, 'conversation', {}).get('messages', [])
        text = history[-2].get('text', '') if len(history) >= 2 else ''
        continuation = re.sub(r'[\s，,。.!！?？、]+', '', text) in {'继续', '继续吧', '好的继续', '好继续', '继续制作', '继续生成'}
        if continuation and (name in {'repair_production_step', 'keep_production_candidate', *storyboard_tools.SCHEMAS}
                or (name in {'generate_asset', 'save_text_asset'} and value.get('nodeId'))
                or (name == 'start_production_plan' and self.production and self.production.list(turn.owner))):
            raise ProjectError('“继续”只能按原设置续做，不能据此覆盖选中节点、改写步骤或重复建计划；请明确修改对象与要求。', 409)
        edit = video_edit_request(turn)
        if edit and (name == 'start_production_plan' or name == 'generate_asset' and value['kind'] != 'video'):
            raise ProjectError('本轮是对引用原视频进行编辑，请直接提交 video 参考任务并保留原要求；未创建关键帧或多镜重制计划。', 409)
        if name in production_tools.SCHEMAS:
            return await production_tools.execute(self.production, turn, name, value, operation_id)
        if name == "start_production_plan":
            if not self.production:
                raise ProjectError("制作计划服务未启动。", 409)
            plan = await self.production.submit(turn.owner, operation_id, value, turn.selections, turn.session)
            return {"status": plan["status"], "planId": plan["id"], "name": plan["title"], "shots": len(plan["shots"]),
                    'scriptAssetId': plan['scriptAssetId'], 'scriptFingerprint': plan.get('scriptFingerprint')}
        if name in storyboard_tools.SCHEMAS:
            return await asyncio.to_thread(storyboard_tools.execute, self.storyboard, turn, name, value, operation_id)
        if name == "read_project":
            return await asyncio.to_thread(self._project, turn)
        if name == "read_text_asset":
            data, asset = await asyncio.to_thread(self.store.asset, turn.owner, value["assetId"])
            if not (asset.get("kind") == "text" or asset["type"].startswith("text/")) or len(data) > 64 * 1024:
                raise ProjectError("请选择不超过 64 KB 的文本资产。")
            return {"assetId": value["assetId"], "text": data.decode("utf-8-sig"), 'fingerprint': asset['fingerprint']}
        if name == "get_generation_task":
            snapshot = await asyncio.to_thread(self.canvas.snapshot, turn.owner)
            task = next((task for task in snapshot["tasks"] if task["id"] == value["taskId"]), None)
            if task is None:
                raise ProjectError("任务不在当前项目中。", 404)
            return production_tools.task_summary(task)
        snapshot = await asyncio.to_thread(self.canvas.snapshot, turn.owner)
        node_id = value.get("nodeId")
        kind = "text" if name == "save_text_asset" else value["kind"]
        config_id = None
        if name == "save_text_asset":
            if not value["name"].lower().endswith((".md", ".txt")):
                raise ProjectError("文本名称需要以 .md 或 .txt 结尾。")
        else:
            model_kind = "agent" if kind == "text" else kind
            config_id = turn.selections.get(model_kind)
            if model_kind not in turn.selections:
                config_id = next((item["id"] for item in self.configs.list() if item["kind"] == model_kind), None)
            if not config_id:
                raise ProjectError("尚未选择该类别模型，请先在设置中配置并在右侧选择。", 409)
            config = self.configs.resolve(config_id, model_kind)
            self.generation.provider.validate(kind, config)
        node = next((node for node in snapshot["canvas"]["nodes"] if node["id"] == node_id), None)
        if node_id and node is None:
            raise ProjectError("选中节点已移除，请读取最新项目。", 409)
        if node is not None and value.get("expectedRevision") != node["revision"]:
            raise ProjectError("修改节点需要读取到的最新 expectedRevision；节点可能已变化，请重新读取并核对。", 409)
        if node is not None and node["kind"] != kind:
            raise ProjectError("节点类型不匹配，请创建对应类型的新节点。")
        if name == 'generate_asset' and node and self.production and any(
                step['nodeId'] == node['id'] for plan in self.production.list(turn.owner) for step in plan['steps']):
            raise ProjectError('该节点属于制作计划，请核对对应步骤并使用局部修复；未直接重新生成。', 409)
        if name == "save_text_asset":
            user = turn.conversation['messages'][-2]
            asset = await asyncio.to_thread(self.canvas.save_text, turn.owner, node["id"] if node else str(uuid5(UUID(operation_id), "node")), str(uuid5(UUID(operation_id), "asset")), value["text"], value["name"], turn.session, create=node is None, expected_revision=value.get("expectedRevision"),
                agent_run={"id": turn.id, "modelConfigId": turn.config["id"], "referenceIds": [asset["id"] for asset in user['assets']],
                    'inputs': {'prompt': user['text'], 'promptContent': user.get('content'), 'referenceIds': [asset['id'] for asset in user['assets']],
                        'referenceFingerprints': {asset['id']: asset['fingerprint'] for asset in user['assets']},
                        'modelName': turn.config['modelId'], 'modelURL': turn.config['url']}})
            return {"status": "succeeded", "nodeId": node["id"] if node else str(uuid5(UUID(operation_id), "node")), "assetId": asset["id"], "name": asset["name"], 'fingerprint': asset['fingerprint']}
        if kind == 'video':
            if edit:
                value = preserve_video_edit(value, edit, config)
            elif value.get('videoMode') is None:
                value = {**value, 'videoMode': node['videoMode'] if node else input_rules(config)['videoModes'][0]}
        create = None if node else {"kind": kind}
        node_id = node["id"] if node else str(uuid5(UUID(operation_id), "node"))
        task = await self.generation.submit(turn.owner, node_id, {"id": operation_id, "modelConfigId": config_id,
            "expectedRevision": value["expectedRevision"] if node else 1,
            "inputs": {"prompt": value["prompt"], "promptContent": value.get("promptContent"), "referenceIds": value["referenceIds"], "videoMode": value.get('videoMode') or 'first_frame', "title": value.get("name") or (node["title"] if node else "")}}, turn.session, create=create)
        return {"status": task["status"], "nodeId": node_id, "taskId": task["id"], "assetId": task["assetId"],
                **({"message": "已按本次会话原文保留原视频和角色参考，提交视频参考生成。",
                    "referenceIds": task["referenceIds"], "videoMode": task["videoMode"]} if edit else {})}

    async def stream(self, turn):
        run = {"id": turn.id, "status": "running", "steps": [], "protocol": []}
        context = await asyncio.to_thread(self._context, turn)
        effects = 0
        observation_epoch = 0
        observations = set()
        repair_failed = False
        reads = {'read_project', 'get_generation_task', 'get_production_plan', 'list_production_plans'}
        writes = {'save_text_asset', 'generate_asset', 'start_production_plan', *storyboard_tools.SCHEMAS, *production_tools.WRITES}
        try:
            for _ in range(6):
                payload = chat_payload(turn.config, context, turn.thinking)
                payload["tools"] = TOOLS
                message = None
                async for chunk in self.provider.stream(turn.config, payload):
                    if chunk["type"] == "assistant_message":
                        message = chunk["message"]
                    else:
                        yield chunk
                if message is None:
                    raise ProjectError("模型未返回完整工具协议，请核对接口兼容性。", 502)
                context.append(message)
                run["protocol"].append(message)
                calls = message.get("tool_calls") or []
                if not calls:
                    run["status"] = "complete"
                    return
                for call in calls:
                    if turn.stop.is_set():
                        return
                    if len(run["steps"]) >= 12:
                        raise ProjectError("已达到本轮工具调用上限，已完成成果保留。", 409)
                    name = call["function"]["name"]
                    operation_id = str(uuid5(UUID(turn.id), call["id"]))
                    previous = next((step for step in run["steps"] if step["id"] == call["id"]), None)
                    arguments = call["function"]["arguments"]
                    if previous:
                        if previous["name"] != name or previous["arguments"] != arguments:
                            raise ProjectError("模型重复使用工具标识但改变参数，已停止执行。", 409)
                        result = previous["result"]
                    else:
                        step = {"id": call["id"], "name": name, "arguments": arguments, "status": "running", "result": None}
                        run["steps"].append(step)
                        await asyncio.to_thread(self._save, turn, deepcopy(run))
                        yield {"type": "tool", "name": name, "status": "running"}
                        try:
                            if name not in SCHEMAS:
                                raise ProjectError("工具不存在。")
                            value = SCHEMAS[name][0].model_validate_json(arguments).model_dump(mode="json")
                            if repair_failed and name in {'generate_asset', 'start_production_plan', 'create_storyboard_shot'}:
                                raise ProjectError('局部修复尚未通过核对，不能改用新素材或新计划绕过；请说明原因并等待用户处理。', 409)
                            if name in writes:
                                effects += 1
                                if effects > 4:
                                    raise ProjectError("本轮最多执行四次写入或生成操作，已有成果保留。", 409)
                            observation = (observation_epoch, name, json.dumps(value, sort_keys=True))
                            if name in reads:
                                if observation in observations:
                                    raise ProjectError('本轮已读取该对象，未重复轮询；请依据已有状态回复，后台任务会继续。', 409)
                                observations.add(observation)
                            result = await self.execute(turn, name, value, operation_id)
                            if name in writes:
                                observation_epoch += 1
                            step["status"] = "complete"
                        except (ProjectError, ValidationError, UnicodeError, ValueError) as failure:
                            if name == 'repair_production_step':
                                repair_failed = True
                            result = {"error": str(failure) if isinstance(failure, ProjectError) else argument_error(failure)}
                            step["status"] = "failed"
                        step["result"] = result
                    result_message = {"role": "tool", "tool_call_id": call["id"], "content": json.dumps(result, ensure_ascii=False)}
                    context.append(result_message)
                    run["protocol"].append(result_message)
                    await asyncio.to_thread(self._save, turn, deepcopy(run))
                    failed = (previous or step)['status'] == 'failed'
                    # Reading a failed production task is a successful read;
                    # its diagnostic belongs in the tool data, not an API error.
                    public_fields = ('error',) if failed else ('nodeId', 'assetId', 'taskId', 'message')
                    yield {"type": "tool", "name": name, "status": "failed" if failed else "complete",
                           **{key: result[key] for key in public_fields if key in result}}
            raise ProjectError("已达到本轮模型决策上限，已创建成果和后台任务保留。", 409)
        finally:
            if run["status"] != "complete":
                run["status"] = "interrupted"
            with anyio.CancelScope(shield=True):
                await asyncio.to_thread(self._save, turn, deepcopy(run))
