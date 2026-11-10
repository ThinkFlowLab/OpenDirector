# 使用可灵 4.0 和 Flash 生成视频

[English](kling-video.md)

## 接入账户

1. 在可灵开发者控制台创建 API Key。账户需有所选可灵型号的调用权限，以及足够的 API 余额或资源包额度。
2. 打开 **设置 → 模型接入 → 视频 → 添加服务**。
3. 选择 **可灵官方视频**。北京服务使用 `https://api-beijing.klingai.com`；国际账户可改用 `https://api-singapore.klingai.com`。切换界面语言不会改变服务地址。
4. 填入 API Key，启用 `kling-4.0`、`kling-4.0-flash`，或同时启用两者。
5. 保存服务。需要使用可灵时，在生成模型选择器中明确选择它；添加服务会保留已有模型选择。

支持的型号和输出规格来自内置声明。载入它们不验证密钥，也不提交付费任务。

## 选择输入方式

- 文生视频只填写提示词，不添加图片。
- 首帧生视频选择首尾帧模式，填入首帧槽位。
- 首尾帧生视频选择 `kling-4.0`，填入两个槽位。Flash 仅支持首帧。输出画幅由帧图片决定。
- 图片参考选择素材参考模式，再添加图片。参考图片约束内容或风格，不代表指定首帧。

使用每张不超过 30 MB 的 JPEG 或 PNG 图片。宽高均需至少 300 像素，比例在 2:5 到 5:2 之间。图片参考模式最多支持十张图片，并受编码后请求大小限制；帧模式支持一张首帧，仅 `kling-4.0` 额外支持一张可选尾帧。

按型号选择输出规格：

| 型号 | 分辨率 | 整数时长 | 帧输入 |
| --- | --- | --- | --- |
| `kling-4.0` | 720P 或 1080P | 3–30 秒 | 首帧，可选尾帧 |
| `kling-4.0-flash` | 720P | 3–20 秒 | 仅首帧 |

OpenDirector 对两个型号均默认使用 5 秒，并使用原生音频。视频参考、中间帧、远端主体、音色参考和保留输入视频原声不属于当前支持的输入能力。

## 查看和恢复结果

在工程中查看任务进度。生成完成后，视频会下载、检查并登记为工程资产和结果候选。采用结果继续遵守已有版本和锁定规则，任务完成不会覆盖更新的编辑。

生成文件的下载和恢复缓存当前限制为 50 MB。即使可灵生成成功，超过此大小的文件也无法保存。下载失败时恢复原任务，不要直接重新生成。

提交超时可能导致接收状态不明，请先核对原任务。本地取消不代表远端已取消或退款。

## 官方接口资料

适配器使用不带 `/v1` 前缀的新版接口和 Bearer API Key 鉴权。在执行前固定本次提交路径并记录到任务中，三个路径共用任务查询和工程结果处理。

- [文生视频](https://klingai.com/document-api/api/video/4-0/text-to-video)。
- [图生视频](https://klingai.com/document-api/api/video/4-0/image-to-video)。
- [全能参考生视频](https://klingai.com/document-api/api/video/4-0/video-omni)。
- [Flash 文生视频](https://klingai.com/document-api/api/video/4-0-flash/text-to-video)。
- [Flash 图生视频](https://klingai.com/document-api/api/video/4-0-flash/image-to-video)。
- [Flash 全能参考生视频](https://klingai.com/document-api/api/video/4-0-flash/video-omni)。
- [错误码](https://klingai.com/document-api/api/get-started/error-codes)。
