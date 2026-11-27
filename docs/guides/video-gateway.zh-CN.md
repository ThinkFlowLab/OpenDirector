# 用一个 vLLM-Omni 服务提供多个 H3 变体

[English](video-gateway.md)

视频转发层是一个随 OpenDirector 一起启动的本地小服务。它位于 OpenDirector 和自部署的 [vLLM-Omni](https://github.com/vllm-project/vllm-omni) 视频服务之间，让一个服务以多个模型的名义出现，每个模型有自己的步数和 LoRA，按模型名选择。

## 什么时候需要

vLLM-Omni 在原版权重上提供少步数的 MiniMax-H3 适配器，例如 Pika Flex Turbo。每个请求都必须在 `lora` 字段里指明适配器，并使用该适配器对应的步数和流偏移，否则服务会拒绝。OpenDirector 的 FastH3-Omni 视频请求不带 `lora`，步数固定为 8，所以无法直接使用这些适配器。

转发层为每个请求补上服务需要的内容。FastH3 Omni 和原版 MiniMax-H3 不需要它，OpenDirector 可以直接驱动。

## 配置

在 OpenDirector 数据目录中创建 `.opendirector/video-gateway.yaml`，与 `models.json` 放在一起。可以从 [`tools/video-gateway/video-gateway.example.yaml`](../../tools/video-gateway/video-gateway.example.yaml) 开始，其中说明了每个配置项。

```yaml
listen:
  host: 127.0.0.1
  port: 8101

# 模型名不在下面列表中的请求，原样转发到这里。
default_backend: http://127.0.0.1:8091

models:
  Pika-Labs/Pika-H3-Flex-Turbo-4step:
    backend: http://127.0.0.1:8091
    backend_model: MiniMaxAI/MiniMax-H3
    set:
      num_inference_steps: 4
      guidance_scale: 1
      flow_shift: 12
    extra_params:
      audio_flow_shift: 3
    lora:
      name: pika-h3-flex-turbo-4step
      path: /path/to/loras/pika_h3_flex_turbo_4step_ref2va.safetensors
      scale: 1.0
```

| 配置项 | 含义 |
| --- | --- |
| `backend` | 运行该模型的 vLLM-Omni 服务地址 |
| `backend_model` | 该服务启动时使用的名字（`--served-model-name`）；默认与条目名相同 |
| `set` | 强制设为这些值的表单字段，覆盖客户端发送的值 |
| `defaults` | 仅在客户端未发送时才补上的表单字段 |
| `extra_params` | 强制写入请求 `extra_params` JSON 的键 |
| `lora` | 作为请求 `lora` 发送的 `{name, path, scale}`。`lora: null` 会去掉客户端发送的 `lora`；不写这一项则保留客户端自己的 |

`lora.path` 是 vLLM-Omni 服务器上的路径，该服务器可能是另一台机器。转发层只发送这个路径，不做检查；文件缺失或不匹配时，由服务在收到请求时报告。该服务需以 `--lora-backend peft` 启动，才会接受请求里的 `lora`。

OpenDirector 发出的步数固定为 8，所以权重需要其他步数的条目必须在 `set` 里强制指定。

## 启动

只要配置文件存在，`opendirector serve` 就会一并启动转发层，并在应用退出时停止它：

```text
Video gateway / 视频转发层: http://127.0.0.1:8101/v1  (.../.opendirector/video-gateway.yaml)
OpenDirector: http://127.0.0.1:8000  (Ctrl+C 退出)
```

配置文件放在别处时，可以显式指定：`opendirector serve --video-gateway /path/to/video-gateway.yaml`。`opendirector dev` 支持同一个选项。没有配置时不会启动转发层。

配置文件无效或 `listen.port` 被占用时，启动会停止并说明原因，不会留下任何进程。转发层默认监听 `127.0.0.1`，不做鉴权，请保持在本机回环地址上，或放在你自己的访问控制之后。

## 接入 OpenDirector

在 **设置 → 模型接入 → 视频 → 添加服务** 中选择 **vLLM-Omni 视频接口**：

- 地址：转发层，例如 `http://127.0.0.1:8101/v1`
- Model ID：`models` 里的一个名字
- 请求格式：**FastH3-Omni（8 步、多素材参考）**

每个配置的名字添加一个模型。不在配置文件里的模型名，只要默认后端以该名字提供服务，经过转发层同样可用。

## 转发层对请求做了什么

- 视频创建请求（`POST /v1/videos` 或 `POST /v1/videos/sync`）的 `model` 在配置里时，按配置改写后发给该条目的后端。上传的文件原样传递。
- 其他模型名的请求原样转给 `default_backend`。
- 状态查询、下载和取消会转给创建该任务的后端。转发层重启后，会带着调用方的凭证重新查找任务所在的后端。
- 转发层直连后端，不使用环境变量里的代理设置（例如 `HTTP_PROXY`）。
- `GET /v1/models` 先列出配置里的名字，再列出默认后端自己的。
- 每次改写都会记录改动了哪些字段，日志与应用在同一个终端里。

配置文件变化时会重新读取模型列表，因此添加模型或修改步数不需要重启。加载失败时继续使用上一份列表，并在日志里说明原因。修改 `listen` 地址在下次启动时生效。

## 限制

- 转发层不能让服务接受它不支持的模型名或适配器：后端仍会校验收到的请求。
- 同一个服务上切换 LoRA，每个适配器第一次使用时会多花一些时间。
- 改写请求时，请求体会完整读入内存，上限 768 MiB。
- 只改写 vLLM-Omni 视频创建请求。图片、音频和对话服务不经过转发层。
- `opendirector serve` 和 `opendirector dev` 会启动转发层，桌面应用不会。需要单独运行时（例如配合桌面应用），使用 `python -m opendirector.video_gateway /path/to/video-gateway.yaml`。
