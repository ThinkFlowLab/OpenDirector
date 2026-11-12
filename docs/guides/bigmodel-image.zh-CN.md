# 智谱 BigModel GLM-Image

## 配置

打开 **设置 → 模型接入 → 图片 → 添加服务**，选择 **智谱 BigModel**，填写
BigModel API Key。预设地址为 `https://open.bigmodel.cn/api/paas/v4`，型号为
`glm-image`。账户需要有图片 API 权限和余额；编程订阅不能代替图片 API 额度。
保存连接不会生成图片。密钥保存在本机模型设置中，不进入工程快照。

## 生成与采用

创建图片生成节点，选择 `glm-image`，输入提示词并选择提供的比例和尺寸。
GLM-Image 仅支持文生图，可引用文本素材补充要求，不支持参考图片和图片编辑。
可选尺寸为 1280×1280、1568×1056、1056×1568、1472×1088、1088×1472、
1728×960 和 960×1728，默认 1280×1280。

同步接口返回一个图片地址。OpenDirector 下载并解码图片，将其存为工程内的
PNG 素材并登记候选结果。沿用现有采用策略：输入未改变时可自动采用；
仅登记候选的生成需要手动选择结果。采用后关闭并重新打开工程，可查看同一本地
素材，无需再次调用 BigModel。

Agent 使用同一模型配置、`generation.submit` 命令、校验、候选存储及
`result.select` 采用操作。图片服务配置与对话 Agent 使用的聊天模型配置相互独立。

设置中的「去除水印」取反后发送为 BigModel 的 `watermark_enabled`。
BigModel 仅允许已签署免责声明的账户去水印，签署路径为「个人中心 → 安全管理 → 去水印管理」。
账户未取得该权限时，即使请求去水印，服务商仍可能返回带水印图片；开启去水印时，生成按钮上方会显示提示。
OpenDirector 保留服务商原始输出，不在本地擦除水印。
适配器仅发送 `model`、`prompt`、`size`
和 `watermark_enabled`，不发送 OpenAI 专用的 `n`、`response_format` 和
`output_format` 参数。

## 失败与恢复

鉴权、余额、限流及提供方错误会显示在生成反馈中。提交超时代表受理状态未知，
不会自动重复付费生成。结果地址登记后，下载失败可恢复原下载，不重新生成。
CDN 下载不携带提供方凭证，拒绝私有网络地址及跳转到此类地址的重定向。
结果地址过期时可能需要明确发起新生成。工程保存的是已下载图片，不依赖远端地址
长期有效。

协议和持久化测试使用模拟 HTTP 与真实图片字节：

```sh
.venv/bin/python -m pytest tests/test_bigmodel_image.py -q
node --test tests/providerPresets.test.ts
```

这些检查不能替代真实账户验收。真实验收需配置账户、生成可解码图片、采用结果、
重开工程，并保存流程截图。

参见[官方图片 API](https://docs.bigmodel.cn/api-reference/模型-api/图像生成)和
[English guide](bigmodel-image.md)。
