import asyncio
import os
import time
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import urlparse
from uuid import UUID

from fastapi import FastAPI, Header, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from filelock import Timeout
from starlette.concurrency import run_in_threadpool

from opendirector.installation import data_root, web_root
from opendirector.wiring import configure_runtime
from opendirector.domain.projects import ProjectError, identifier
from opendirector.domain.creation.validation import ContractError
from opendirector.domain.settings import GeneralSettings, GeneralSettingsPatch
from opendirector.application.creation_generation import CreationGeneration
from opendirector.application.tool_tasks import ToolTasks
from opendirector.application.creation_tool_assets import CreationToolAssets
from opendirector.infrastructure.app_settings import AppSettings
from opendirector.infrastructure.local_projects import LocalProjects
from opendirector.infrastructure.creation_projects import CreationProjects
from opendirector.infrastructure.model_configs import ModelConfigs, connection_fields, model_fields
from opendirector.domain.input_rules import input_rules
from opendirector.integrations.model_capabilities import read_service_models, read_video_capabilities
from opendirector.integrations.chat_completions import ChatCompletions, chat_payload
from opendirector_api.creation import creation_routes
from opendirector_api.agent import agent_routes
from opendirector_api.library import library_routes
from opendirector_api.localization import localized_error
from opendirector_api.models import (ModelConfigInput, ModelConfigPublic, AgentModelTest,
    ModelCapabilityRequest, ModelDiscoveryRequest, ModelBatchInput,
    ToolTaskCreate, ToolPlacement, ImageSelectionCreate)


def create_app(store: LocalProjects | None = None, chat_provider=None, generation_provider=None) -> FastAPI:
    configure_runtime()
    repository = data_root()
    if store is None:
        store = LocalProjects(repository)
    model_configs = ModelConfigs(store.repository)
    settings = AppSettings(store.repository)
    creation_projects = CreationProjects(store)
    creation_generation = CreationGeneration(creation_projects, model_configs, generation_provider)
    creation_tools = ToolTasks(store, model_configs, CreationToolAssets(creation_projects), projects=creation_projects)
    model_tester = chat_provider or ChatCompletions()

    @asynccontextmanager
    async def lifespan(app):
        await creation_generation.start()
        try:
            await creation_tools.start()
            yield
        finally:
            try:
                await creation_tools.close()
            finally:
                await creation_generation.close()

    app = FastAPI(title="OpenDirector Local API", version="0.1.0", lifespan=lifespan)
    app.include_router(creation_routes(creation_projects, creation_generation))
    app.include_router(agent_routes(creation_projects, creation_generation, model_configs, chat_provider))
    app.include_router(library_routes(creation_projects))

    @app.exception_handler(RequestValidationError)
    async def invalid_request(request, error):
        # Validation errors must not echo request input containing credentials.
        chinese = "请求字段无效，请检查必填项及字段格式。"
        return JSONResponse(
            {
                "detail": localized_error(
                    request, chinese=chinese, status=422, code="invalid_input"
                ),
                "code": "invalid_input",
            },
            status_code=422,
        )

    @app.exception_handler(ProjectError)
    async def project_error(request, error):
        return JSONResponse(
            {
                "detail": localized_error(
                    request,
                    chinese=str(error),
                    status=error.status,
                    code=error.code,
                ),
                "code": error.code,
            },
            status_code=error.status,
        )

    @app.exception_handler(ContractError)
    async def contract_error(request, error):
        status = 404 if error.issue.code == 'missing_object' else 409 if error.issue.code in {'revision_conflict', 'preview_expired'} else 422
        return JSONResponse(
            {
                "detail": localized_error(
                    request,
                    chinese=error.issue.message,
                    status=status,
                    code=error.issue.code,
                ),
                "code": error.issue.code,
            },
            status_code=status,
        )

    @app.exception_handler(OSError)
    async def disk_error(request, error):
        chinese = "文件操作失败，请检查目录权限、磁盘空间及文件是否被占用；原有项目数据不会自动删除。"
        return JSONResponse(
            {
                "detail": localized_error(
                    request, chinese=chinese, status=503, code="storage_unavailable"
                )
            },
            status_code=503,
        )

    @app.exception_handler(Timeout)
    async def lock_error(request, error):
        chinese = "项目存储正忙，请稍后重试。"
        return JSONResponse(
            {
                "detail": localized_error(
                    request, chinese=chinese, status=409, code="storage_busy"
                ),
                "code": "storage_busy",
            },
            status_code=409,
            headers={"Retry-After": "1"},
        )

    @app.middleware("http")
    async def local_requests(request: Request, call_next):
        if request.url.path.startswith("/api/"):
            if request.url.hostname not in {"localhost", "127.0.0.1", "::1", "testserver"}:
                chinese = "仅允许本机访问项目服务。"
                return JSONResponse(
                    {
                        "detail": localized_error(
                            request, chinese=chinese, status=403, code="local_only"
                        )
                    },
                    status_code=403,
                )
            origin = request.headers.get("origin")
            if origin and urlparse(origin).hostname not in {"localhost", "127.0.0.1", "::1"}:
                chinese = "不允许来自其他站点的文件访问。"
                return JSONResponse(
                    {
                        "detail": localized_error(
                            request,
                            chinese=chinese,
                            status=403,
                            code="cross_origin",
                        )
                    },
                    status_code=403,
                )
            if request.headers.get("x-opendirector-request") != "1":
                chinese = "无效的本地应用请求。"
                return JSONResponse(
                    {
                        "detail": localized_error(
                            request,
                            chinese=chinese,
                            status=403,
                            code="invalid_local_request",
                        )
                    },
                    status_code=403,
                )
        return await call_next(request)

    @app.get("/api/health")
    def health():
        return {"status": "ok"}

    @app.get("/api/model-configs", response_model=list[ModelConfigPublic])
    def list_model_configs():
        return model_configs.list()

    @app.get('/api/settings', response_model=GeneralSettings)
    def get_settings():
        return settings.get()

    @app.patch('/api/settings', response_model=GeneralSettings)
    def update_settings(value: GeneralSettingsPatch):
        return settings.update(value.model_dump())

    @app.delete('/api/model-services/{config_id}', status_code=204)
    def delete_model_service(config_id: UUID):
        model_configs.delete_service(str(config_id))

    @app.post('/api/model-configs/batch', response_model=list[ModelConfigPublic])
    def save_model_batch(value: ModelBatchInput):
        return model_configs.save_many(value.kind, value.url, value.modelIds, value.apiKey.get_secret_value(),
                                       str(value.configId) if value.configId else None, connection_type=value.connectionType,
                                       protocol=value.protocol, auth_mode=value.authMode, proxy_mode=value.proxyMode, video_adapter=value.videoAdapter,
                                       video_capabilities=value.videoCapabilities.model_dump(exclude_none=True) if value.videoCapabilities else None,
                                       input_modalities=value.inputModalities,
                                       model_options={key: item.model_dump(exclude_unset=True) for key, item in value.modelOptions.items()},
                                       capabilities_supplied='videoCapabilities' in value.model_fields_set)

    @app.post('/api/model-configs/discover')
    async def discover_models(value: ModelDiscoveryRequest):
        config = {**model_fields(value.url, value.modelId or 'discovery', value.apiKey.get_secret_value()),
                  'kind': value.kind, **connection_fields(value.kind, value.connectionType, value.protocol, value.authMode, value.proxyMode)}
        if config['authMode'] == 'bearer' and not config['apiKey']:
            existing = await run_in_threadpool(model_configs.resolve, str(value.configId), value.kind) if value.configId else None
            if not existing or existing['url'] != config['url'] or not existing['apiKey']:
                raise ProjectError('请填写该服务的 API Key；新地址不能复用原地址的密钥。')
            config['apiKey'] = existing['apiKey']
        models = await read_service_models(config)
        return {'models': list(dict.fromkeys(item['id'] for item in models))}

    @app.post('/api/model-configs/test-agent')
    async def test_agent_model(value: AgentModelTest):
        config = {**model_fields(value.url, value.modelId, value.apiKey.get_secret_value()), 'kind': 'agent',
                  **connection_fields('agent', value.connectionType, value.protocol, value.authMode, value.proxyMode)}
        if config['authMode'] == 'bearer' and not config['apiKey']:
            existing = await run_in_threadpool(model_configs.agent, str(value.configId)) if value.configId else None
            if not existing or existing['url'] != config['url'] or not existing['apiKey']:
                raise ProjectError('请填写该服务的 API Key；新地址不能复用原地址的密钥。')
            config['apiKey'] = existing['apiKey']
        payload = chat_payload(config, [{'role': 'user', 'content': 'Reply with OK only.'}], 'auto')
        payload['max_tokens'] = 1024
        started = time.monotonic()
        received = False
        try:
            async with asyncio.timeout(30):
                async for event in model_tester.stream(config, payload):
                    if event['type'] == 'delta' and event['text'].strip():
                        received = True
        except TimeoutError:
            raise ProjectError('测试超时（30 秒），请检查服务地址及模型状态。', 504) from None
        if not received:
            raise ProjectError('模型未返回正文，请检查 Chat Completions 兼容性。', 502)
        return {'elapsedMs': round((time.monotonic() - started) * 1000)}

    @app.post("/api/model-configs", response_model=ModelConfigPublic)
    def create_model_config(value: ModelConfigInput):
        return model_configs.save(value.kind, value.url, value.modelId, value.apiKey.get_secret_value(), connection_type=value.connectionType, protocol=value.protocol, auth_mode=value.authMode, proxy_mode=value.proxyMode,
                                  video_adapter=value.videoAdapter, video_capabilities=value.videoCapabilities.model_dump(exclude_none=True) if value.videoCapabilities else None,
                                  capabilities_supplied='videoCapabilities' in value.model_fields_set, input_modalities=value.inputModalities)

    @app.post('/api/model-configs/capabilities')
    async def model_capabilities(value: ModelCapabilityRequest):
        if value.kind != 'video':
            raise ProjectError('能力配置仅适用于视频模型。')
        config = {**model_fields(value.url, value.modelId, value.apiKey.get_secret_value()), 'kind': value.kind,
                  **connection_fields(value.kind, value.connectionType, value.protocol, value.authMode, value.proxyMode), 'videoAdapter': value.videoAdapter or 'auto'}
        if value.source == 'preset':
            return {'videoCapabilities': input_rules(config).get('videoCapabilities')}
        if config['authMode'] == 'bearer' and not config['apiKey']:
            existing = model_configs.resolve(str(value.configId), 'video') if value.configId else None
            if not existing or existing['url'] != config['url']:
                raise ProjectError('请填写该服务的 API Key；新地址不能复用原地址的密钥。')
            config['apiKey'] = existing['apiKey']
        return {'videoCapabilities': await read_video_capabilities(config)}

    @app.patch("/api/model-configs/{config_id}", response_model=ModelConfigPublic)
    def update_model_config(config_id: UUID, value: ModelConfigInput):
        return model_configs.save(value.kind, value.url, value.modelId, value.apiKey.get_secret_value(), str(config_id), connection_type=value.connectionType, protocol=value.protocol, auth_mode=value.authMode, proxy_mode=value.proxyMode,
                                  video_adapter=value.videoAdapter, video_capabilities=value.videoCapabilities.model_dump(exclude_none=True) if value.videoCapabilities else None,
                                  capabilities_supplied='videoCapabilities' in value.model_fields_set, input_modalities=value.inputModalities)

    @app.delete("/api/model-configs/{config_id}", status_code=204)
    def delete_model_config(config_id: UUID):
        model_configs.delete(str(config_id))

    @app.get('/api/tools')
    def tool_catalog():
        return creation_tools.catalog()

    def register_selection_route(service, prefix):
        @app.post(prefix)
        async def image_selection(project_id: UUID, value: ImageSelectionCreate, request: Request,
                                  x_opendirector_session: str = Header()):
            # Preview work has no durable task; disconnecting cancels the local
            # upstream request without disturbing accepted tool executions.
            work = asyncio.create_task(service.selection_preview(str(project_id), value.model_dump(mode='json'),
                                                               identifier(x_opendirector_session)))

            async def disconnected():
                # The body has been decoded by FastAPI. Wait on the remaining
                # ASGI events: is_disconnected() uses a cancelled scope that can
                # miss disconnects through BaseHTTPMiddleware's receive stream.
                while (await request.receive())['type'] != 'http.disconnect':
                    pass

            disconnect = asyncio.create_task(disconnected())
            try:
                done, _ = await asyncio.wait((work, disconnect), return_when=asyncio.FIRST_COMPLETED)
                return await work if work in done else Response(status_code=499)
            finally:
                for task in (work, disconnect):
                    if not task.done():
                        task.cancel()
                await asyncio.gather(work, disconnect, return_exceptions=True)

    register_selection_route(creation_tools, '/api/creation/projects/{project_id}/image-selections')

    def register_tool_routes(service, prefix):
        @app.get(prefix)
        def tool_tasks(project_id: UUID):
            return {'tasks': service.list(str(project_id))}

        @app.post(prefix, status_code=202)
        async def submit(project_id: UUID, value: ToolTaskCreate, x_opendirector_session: str = Header()):
            return await service.submit(str(project_id), value.model_dump(mode='json', exclude_none=True), identifier(x_opendirector_session))

        @app.get(prefix + '/{task_id}')
        def task(project_id: UUID, task_id: UUID):
            return service.get(str(project_id), str(task_id))

        @app.post(prefix + '/{task_id}/cancel')
        async def cancel(project_id: UUID, task_id: UUID, x_opendirector_session: str = Header()):
            return await service.cancel(str(project_id), str(task_id), identifier(x_opendirector_session), wait=False)

        @app.post(prefix + '/{task_id}/placement')
        def placement(project_id: UUID, task_id: UUID, value: ToolPlacement, x_opendirector_session: str = Header()):
            return service.placement(str(project_id), str(task_id), value.state, identifier(x_opendirector_session), policy=value.policy)

    register_tool_routes(creation_tools, '/api/creation/projects/{project_id}/tool-tasks')

    dist = web_root()
    if dist.is_dir():
        app.mount("/assets", StaticFiles(directory=dist / "assets", check_dir=False), name="assets")

        @app.get("/")
        def index():
            return FileResponse(dist / "index.html")

        # The canvas restores its project from these client-side addresses.
        @app.get("/ai-canvas/{path:path}")
        @app.get("/ai-tool/{path:path}")
        def canvas_route(path: str):
            return FileResponse(dist / "index.html")

    return app
