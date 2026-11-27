# Serve several H3 variants from one vLLM-Omni server

[中文](video-gateway.zh-CN.md)

The video gateway is a small local service that OpenDirector starts together with the application. It sits between OpenDirector and your self-hosted [vLLM-Omni](https://github.com/vllm-project/vllm-omni) video servers and lets one server appear as several models, each with its own step count and LoRA, chosen by model name.

## When you need it

vLLM-Omni serves few-step MiniMax-H3 adapters, such as Pika Flex Turbo, from the base weights. Each request must name the adapter in a `lora` field and use that adapter's step count and flow shift, or the server rejects it. OpenDirector's FastH3-Omni video requests carry no `lora` and always ask for 8 steps, so these adapters cannot be used directly.

The gateway adds what the server needs to each request. You do not need it for FastH3 Omni or for base MiniMax-H3, which OpenDirector drives directly.

## Configure it

Create `.opendirector/video-gateway.yaml` in the OpenDirector data directory, beside `models.json`. Start from [`tools/video-gateway/video-gateway.example.yaml`](../../tools/video-gateway/video-gateway.example.yaml), which documents every key.

```yaml
listen:
  host: 127.0.0.1
  port: 8101

# Requests whose model is not listed below are forwarded here unchanged.
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

| Key | Meaning |
| --- | --- |
| `backend` | Base URL of the vLLM-Omni server that runs this model |
| `backend_model` | The name that server was started with (`--served-model-name`); defaults to the entry's name |
| `set` | Form fields forced to these values, replacing what the client sent |
| `defaults` | Form fields added only when the client did not send them |
| `extra_params` | Keys forced inside the request's `extra_params` JSON |
| `lora` | `{name, path, scale}` sent as the request's `lora`. `lora: null` removes one the client sent; leaving the key out passes the client's own through |

`lora.path` is a path on the vLLM-Omni server, which may be another machine. The gateway sends it without checking it; the server reports a missing or mismatched file when a request arrives. Start that server with `--lora-backend peft` so that it accepts a per-request `lora`.

Because OpenDirector always sends 8 steps, an entry whose weights need another step count must force it under `set`.

## Start it

`opendirector serve` starts the gateway whenever the configuration file exists, and stops it when the application stops:

```text
Video gateway / 视频转发层: http://127.0.0.1:8101/v1  (.../.opendirector/video-gateway.yaml)
OpenDirector: http://127.0.0.1:8000  (Ctrl+C 退出)
```

To use a file somewhere else, pass it explicitly: `opendirector serve --video-gateway /path/to/video-gateway.yaml`. `opendirector dev` accepts the same option. Without a configuration, no gateway is started.

An invalid file or a busy `listen.port` stops the start with a message that names the problem; nothing is left running. The gateway listens on `127.0.0.1` by default and adds no authentication, so keep it on the loopback address or behind your own access control.

## Connect OpenDirector

In **Settings → Model connections → Video → Add service**, select **vLLM-Omni video API**:

- URL: the gateway, for example `http://127.0.0.1:8101/v1`
- Model ID: a name from `models`
- Request format: **FastH3-Omni (8 steps, multi-asset reference)**

Add one model for each configured name. A model name that is not in the file still works through the gateway when the default backend serves it under that name.

## What the gateway does to a request

- A video creation request (`POST /v1/videos` or `POST /v1/videos/sync`) whose `model` is listed is rewritten as configured and sent to that entry's backend. Uploaded files are carried through unchanged.
- A request for any other model name goes to `default_backend` exactly as it arrived.
- Status queries, downloads and cancellation are relayed to the backend that created the job. After a gateway restart, the backend that answers for a job is looked up again with the caller's credentials.
- Backends are reached directly. Proxy settings in the environment, such as `HTTP_PROXY`, are not applied to them.
- `GET /v1/models` lists the configured names, then the default backend's own.
- Each rewrite is logged with the fields it changed, in the same terminal as the application.

The model table is re-read when the file changes, so you can add a model or change a step count without a restart. A file that fails to load keeps the previous table and logs the reason. A changed `listen` address takes effect at the next start.

## Limits

- The gateway cannot make a server accept a name or an adapter it does not support: the backend still validates what it receives.
- Switching between LoRAs on one server takes extra time the first time each adapter is used.
- A request is held in memory while it is rewritten, up to 768 MiB.
- Only vLLM-Omni video creation is rewritten. Image, audio and chat services do not go through the gateway.
- `opendirector serve` and `opendirector dev` start the gateway; the desktop application does not. To run it on its own, for example beside the desktop application, use `python -m opendirector.video_gateway /path/to/video-gateway.yaml`.
