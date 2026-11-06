# OpenAI Images（gpt-image）接入

OpenDirector 把 OpenAI Images API 作为**可选**图像生成服务接入。它使用现有的模型配置路径，不改变默认 provider，也不影响已配置的 vLLM-Omni 自建图像模型。

本文说明如何配置、接口实际发送什么、哪些能力有官方依据，以及失败如何分类。

## 配置步骤

1. 打开模型设置，新增一个「图片生成」服务。
2. 协议选择 **OpenAI 兼容接口**，服务地址填 `https://api.openai.com/v1`。
3. Model ID 填 `gpt-image-1`（或其他官方文档确认的 `gpt-image` 系列模型）。
4. 连接类型选 API，填入 OpenAI API Key。Key 只保存在本机模型配置中，不写入日志、回执或任务错误。

配置保存后即可在画布节点、Agent 工具和统一工程生成任务中选择该模型。未配置该服务时，这些入口保持原有行为。

## 发送的请求

适配器按服务文档构造请求，不发送未声明的字段：

| 场景 | 接口 | 字段 |
| --- | --- | --- |
| 文生图 | `POST /images/generations` | `model`、`prompt`、`size`、`n=1` |
| 参考图编辑 | `POST /images/edits` | 同上，外加重复的 `image[]` 部件 |

- **不发送 `response_format`**：`gpt-image` 固定返回 base64，请求该字段会被服务拒绝。这一条按 profile 区分，OpenAI 兼容的自建服务（如 vLLM-Omni Z-Image-Turbo）仍然发送 `response_format: b64_json`。
- **不发送 `strength`**：`gpt-image` 是指令式编辑，没有强度参数。
- **多张参考图**按 OpenAI 的约定以重复 `image[]` 部件提交，最多 16 张。

## 支持的能力与限制

| 项目 | 取值 | 依据 |
| --- | --- | --- |
| 输出尺寸 | `1024x1024`、`1536x1024`、`1024x1536` | 官方文档列出的三个 wire 尺寸；其他比例由本地重采样 |
| 参考图数量 | 最多 16 张 | 官方文档的编辑上限 |
| 单图大小 | 25 MB | 官方文档的单图上限 |
| 请求总量 | 50 MB | 官方文档的请求上限 |
| 主体抠图 | 支持 | 通过 `background: transparent` 与 PNG 输出实现 |

未在官方文档中确认的参数（例如 `seed`、自定义任意尺寸、部分模型专属开关）不会因为接入该服务而出现在界面上。

## 失败如何分类

错误按类别返回可操作提示，不把供应商原文写进回执，也不记录 API Key：

| 服务行为 | 类别 | 用户看到的提示 |
| --- | --- | --- |
| `401` / `invalid_api_key` | 鉴权失败 | 请在设置中检查 API Key |
| `429` / `rate_limit_exceeded` | 频率限制 | 核对调用频率及套餐额度 |
| `429` / `billing_hard_limit_reached` | 额度不足 | 核对账户余额和套餐额度 |
| `400` / `moderation_blocked` | 输入被拒 | 判定提示词或参考图片违反内容政策，请调整后再生成 |
| `5xx` | 服务暂时不可用 | 先核对已有任务，再处理当前步骤 |

提交阶段的超时按「提交结果不明」处理，不会自动重复提交，避免重复计费。

## 验证范围

仓库内的自动化验证使用模型替身（httpx MockTransport）检查请求形状、参考图部件、尺寸映射与错误分类，命令：

```bash
python -m pytest tests/test_openai_images.py -q
```

**尚未包含**：真实 API Key 下的端到端出图。该验证需要付费凭证，由实现或验收方按 issue 要求补充证据（模型、接口版本、截图或录像），不能用替身结果代替。
