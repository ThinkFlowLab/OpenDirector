# Case03 · H3 Agentic Continuation

> 使用准备好的 Case03 素材替换指定的五位表演者。从 B 开始，反向续接到 A，再正向续接 C → D → E。按 A → B → C → D → E 交付可编辑时间线和 MP4。
>
> **历史基线说明：** Case03 用于逐字复现已验收的旧 ComfyUI 基线，因此保留了旧版提示词（`case03_prompts.json`）、尾帧补齐（A/B/C）和超过 6 秒的窗口（C/D/E）。**规划新素材时严禁模仿这些历史例外。** 校验 Case03 时运行不带 `--enforce-window-limit` 的 `validate_frame_plan.py case03-frame-plan.json`，以及 `check_prompt.py saved-prompts.json --expected case03_prompts.json`。

[分段计划](case03-segment-plan.zh.md)记录源片窗口、肖像顺序、导帧和裁切。五段使用 [Case03 的原版提示词](case03_prompts.json)，随机种子为 0。已发布分组覆盖 24 FPS 的完整工作源片，共 648 帧。

## 打开草稿

选择**导入画布**，打开 [Case03 草稿画布](run-h3-agentic-continuation.canvas)。画布内有素材、五个生成节点、导帧连线、时间线和计划预览。内嵌的视频、肖像和 27 秒演示音轨均为合成占位素材。

1. 在原有节点上替换完整源片、五段输入和五张肖像，保留连线。
2. 将演示音轨替换为交付音轨。交付沿用原声时，绑定源片的原声音轨。模型输入片段保留各自的源内音频。
3. 从 `opendirector project show` 获取素材 ID 和草稿的分组 ID。把分组 ID 传给下方脚本的 `--existing-group`，在同一个组中准备并发布分组。

先发布再使用分组的**运行分组**。草稿里的计划供预览，发布回执会返回正式计划节点的 ID。

## 准备并发布

用 `opendirector model list --kind video` 选择满足 `inputRules.profile: fasth3-omni` 和 `inputRules.videoCapabilities.timelineGuides: true` 的 FastH3 Omni 配置。将 Case03 完整源片归一化为 24 FPS CFR、648 帧，按[输入窗口](case03-segment-plan.zh.md#源片窗口和人物映射)准备五段模型输入。A 和 B 先一起倒放音画，再补帧。在当前项目登记完整源片、五段输入、五张肖像和交付音轨。

| 肖像 | 源人物 | 片段 |
| --- | --- | --- |
| `<Picture 1>` | 原片中穿浅色西装的中间表演者 | A、B、C、D、E |
| `<Picture 2>` | 右侧前景人物 | B、C |
| `<Picture 3>` | 左侧背景人物 | B、C |
| `<Picture 4>` | 左侧前景人物 | B、C |
| `<Picture 5>` | 右侧背景人物 | B、C |

每段使用它自己的已准备片段作为 `<Video 1>`。肖像按上表顺序传入。续接从同一次执行中指定的上游结果取两张导帧。

将 `CASE03_DIR` 设为 skill 的 `examples` 目录。脚本分别生成准备批次和发布命令。省略 `--existing-group` 会新建 Case03 分组，并复用已绑定相同版本素材的可见节点。标准 FastH3 配置默认 480P 为 832 × 480，选择 `--resolution 768P` 时为 1344 × 768。部署尺寸不同时，传入 `--width` 和 `--height`。

```sh
opendirector project show | python3 "$CASE03_DIR/case03_canvas.py" \
  --model "$MODEL_CONFIG_ID" --master "$MASTER_ASSET_ID" \
  --source-a "$SOURCE_A_ID" --source-b "$SOURCE_B_ID" \
  --source-c "$SOURCE_C_ID" --source-d "$SOURCE_D_ID" --source-e "$SOURCE_E_ID" \
  --portrait "$PORTRAIT_1_ID" --portrait "$PORTRAIT_2_ID" --portrait "$PORTRAIT_3_ID" \
  --portrait "$PORTRAIT_4_ID" --portrait "$PORTRAIT_5_ID" \
  --soundtrack "$SOUNDTRACK_ID" --plan-locale zh-CN --publish-file case03.publish.json > case03.batch.json &&
opendirector creation batch --file case03.batch.json &&
opendirector group publish-run --file case03.publish.json
```

已导入草稿时，在构建脚本的参数中加上 `--existing-group "$GROUP_ID"`。准备批次固定源视频和肖像版本，恢复原版提示词，设置随机种子 0，并保留四条指向上游结果的导帧连线。发布时同时保存分组、组装配置和可读计划。启动前检查发布回执的 `planItemId`，并核对对应节点。

## 运行和检查

选中 **Case03 · H3 Agentic Continuation**，选择**运行分组**，或用下方命令启动。为本次启动分配一个 UUID 作为 `START_ID`，保留回执中的执行 ID 供后续查询。

```sh
opendirector --operation-id "$START_ID" group start-run --group-id "$GROUP_ID"
opendirector query run.execution.get --object-id "$RUN_EXECUTION_ID"
```

检查时间线中五个可编辑的画面片段，解码确认 MP4 为 24 FPS、648 帧。审阅人物一致性、动作、接缝和交付音轨。
