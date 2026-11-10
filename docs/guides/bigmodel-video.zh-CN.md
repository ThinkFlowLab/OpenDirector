# 智谱 BigModel CogVideoX-3

[English](bigmodel-video.md)

在「设置 → 模型」中添加「智谱 BigModel 视频」，填写 BigModel API Key，选择 `cogvideox-3`。原生地址为 `https://open.bigmodel.cn/api/paas/v4`，使用 Bearer 鉴权和 `bigmodel_video` 协议。保存或读取该模型的内置能力不会生成视频。账户需要模型权限和足够余额，生成费用由 BigModel 收取。

创建视频节点并选择配置好的模型。选择明确的像素尺寸：`1280x720`、`720x1280`、`1024x1024`、`1920x1080`、`1080x1920`、`2048x1080` 或 `3840x2160`，时长为 5 或 10 秒。画幅由尺寸确定，单独的画幅控件保持「自动」。适配器使用快速质量和 30 帧，并明确发送所选声音及水印设置。提交后，任务会固定这些设置和实际输入图片。

画布操作和 Agent 工具使用相同的业务命令：

- **文生视频**：填写提示词，不选择帧图片。
- **单图生视频**：将 PNG 或 JPEG 导入工程，放入首帧槽位。
- **首尾帧生成**：导入两张图片，明确选择首帧和尾帧。请求始终先发送首帧、再发送尾帧，不依赖引用创建顺序。

图片直接从工程素材读取，以 base64 数据 URI 发送，无需先上传到公网。单张图片须为有效 PNG 或 JPEG，且不超过 5 MB。包含实际传输的文本参考在内，完整提示词最多 512 字符。不支持视频参考、续写和多图参考模式。按共享首帧规则，普通连线中未选入帧槽位的图片仅作为上下文保留。

适配器只向 `/videos/generations` 提交一次，保存远端任务 ID，然后查询 `/async-result/{id}`。重启后继续查询同一 ID。收到 ID 之前超时会保留为「提交结果未知」，等待核对，不会自动重新提交；查询或下载恢复也沿用原任务。尚未接通 BigModel 远端取消接口，停止本地处理不能保证停止远端生成或计费。

生成完成后，视频下载到工程、完成媒体探测，并登记为候选。检查和播放后，显式采用才会修改节点的当前结果。重开工程保留本地视频、候选历史、执行输入和采用状态。公开工程快照不保存临时签名下载地址或 API Key。

协议测试使用模拟 HTTP 和真实图片、视频字节：

```sh
.venv/bin/python -m pytest tests/test_bigmodel_video.py -q
node --test tests/providerPresets.test.ts
```

这些测试不能证明账户权限或创作质量，真实服务验收证据在 PR 中单独记录。

官方资料：[生成接口](https://docs.bigmodel.cn/api-reference/模型-api/视频生成异步)、[结果查询](https://docs.bigmodel.cn/api-reference/模型-api/查询异步结果)、[模型说明](https://docs.bigmodel.cn/cn/guide/models/video-generation/cogvideox-3)、[价格](https://docs.bigmodel.cn/cn/guide/start/pricing)。
