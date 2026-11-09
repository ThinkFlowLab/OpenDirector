# vLLM-Omni deployment validation / 部署验收

Tracking: [#107](https://github.com/ThinkFlowLab/OpenDirector/issues/107), related
[consumer-device integration #224](https://github.com/ThinkFlowLab/OpenDirector/issues/224).
Operational instructions: [English](../guides/vllm-omni.md) / [中文](../guides/vllm-omni.zh-CN.md).

This record separates resource eligibility, actual inference, project delivery
and creative review. 本记录分别记录资源预检、真实推理、工程交付与创作品质审看，不能互相代替。

## Environment / 环境

The source baseline is `f06e22fcd2c1f5767a6b6f0e89708e45ebe86b5c` plus this change.
The GPU host runs Ubuntu 22.04.5, Linux 6.8, Python 3.12.7 and NVIDIA driver
580.126.09. The selected device is one RTX PRO 6000 Blackwell Server Edition
(SM120, 97,887 MiB reported VRAM), on a shared four-device server. Other workloads
remain running. The SSH alias did not describe the actual GPU accurately; hardware
facts came from `nvidia-smi`.
The host C++ compiler is GCC 12.3.0; the isolated CUDA compiler, CRT and NVVM are
13.0.88. The final environment freeze digest is
`54c511a10be9e89faa1da6de930a4f4df55c866d01c6eae966349cf954a53c38`.

GPU 主机默认 Python 为 3.10，使用已有的 3.12.7 解释器创建独立环境。应用安装在另一台
Ubuntu 22.04 主机，使用独立虚拟环境、Python 3.12.13、Node 24.22.2 和生产构建，
通过回环 SSH 隧道连接模型服务。没有修改共享驱动、全局 Python 或现有模型配置。

## Observed problems / 实际问题

- The existing FastH3 tools target Blackwell SM120/NVFP4; they are not an A6000
  deployment recipe. New preflight checks use actual compute capability and free
  per-device memory. 不能将既有 Blackwell 验收套用到 Ampere，也不能合计多卡显存。
- Direct Hugging Face access timed out from the GPU host. The mirror was reachable
  but returned HTTP 429 and downloaded slowly. An existing HTTP proxy on the
  application host was forwarded over SSH to access the official endpoint.
  Downloads remain pinned and use SDK cache/continuation. 网络路径只对本次进程生效。
- Large SDK/Xet transfers continued to back off. The existing FastH3 range
  downloader was reused through an opt-in complete-manifest selection; its
  original selection remains the default and has regression coverage. Shared
  public weights are reused only when their fixed hashes match. 分段日志与已完成权重保留。
  After all image bytes arrived, the SSH command exited 255 during verification;
  read-only process inspection confirmed the original downloader was gone.
  Reconnecting with SSH keepalive and resuming the same command downloaded zero
  ranges and completed both file verification and snapshot registration.
  字节进度 100% 没有被当作校验完成；原操作结束后才复用断点续做。
- The application deliberately declares 768×768 for a square Z-Image output,
  rather than the upstream recipe's 1024×1024. The browser correctly blocked the
  initial incompatible intent. The smoke profile now uses declared 1344×768,
  and the project was updated through the real UI to 16:9/auto with revision 2
  confirmed through the CLI. 没有修改既有输出契约，也没有绕过校验。
- An independent, read-only skill trial reproduced an uncaught missing-state-file
  exception in the new verifier before service startup. It now returns
  `service_not_started`, with a regression test. The trial also prompted explicit
  interpreter-path and service-only status guidance. 该试用是独立 Agent 实操，不是人类新手用户研究。
- The initial TTS startup was terminated by the upstream 300-second stage deadline
  while compilation and CUDA graph capture were still progressing. The profile
  now allows 1200 seconds without disabling the upstream pipeline or optimizations.
  Startup also revealed home-directory compilation caches; the helper now scopes
  vLLM, TorchInductor, Triton and FlashInfer caches to the data directory.
  后续启动进一步暴露出 FlashInfer 找不到编译器；直接编译还确认了原有 CUDA 13.5
  编译器与 13.0 运行时头文件不匹配。编译器、CRT 和 NVVM 固定到 13.0.88，
  接通独立环境内的编译和链接路径后，真实采样内核编译与运行通过，262 个依赖兼容。
  The install command now probes the actual sampling kernel before model loading.
- A PNG with valid chunk checksums but an invalid compressed pixel stream passed
  Pillow's `verify()`. Verification now also decodes pixels, with a regression
  fixture exercising that failure. PNG 头部和校验和通过不能替代实际解码。
- Final receipt inspection found that the environment digest omitted the written
  file's trailing newline. It now hashes the exact UTF-8 bytes; a regression and
  a real installation rerun verified the receipt against the file.
  环境清单哈希与实际文件逐字节一致，不能仅比较规范化后的文本。

## Checks completed / 已完成检查

| Check / 检查 | Result / 结果 |
| --- | --- |
| Isolated OpenDirector source installation | Installed; build hook, bundled OpenCode 1.19.5 and real HTTP startup passed / 安装、构建与实际启动通过 |
| Frontend unit suite | 692 passed |
| Python suite at runtime revision `f902e2b` | 1286 passed, 6 skipped; 300.61 s |
| Deployment and existing FastH3 regression suite after final receipt fix | 53 passed |
| Architecture import contracts | 4 kept |
| Generated contracts | Verified |
| Bilingual catalog | 2935 keys, zero problems |
| Production build | Passed |
| Model environment | vLLM 0.32.0, vLLM-Omni 0.32.0, Torch 2.13.0+cu130, Transformers 5.19.0, Diffusers 0.40.0 |
| CUDA and dependency integrity | CUDA 13.0, SM120, real tensor and FlashInfer sampling kernel passed; `uv pip check` passed |
| Read-only doctor and explicit UUID plans | Passed; missing target directory remains uncreated / 探测不创建目标目录 |
| Independent skill trial | Doctor/plan/status exercised on the real host, CLI discovery checked, no mutations / 实机只读试用 |

The local shell injected a ROS Python plugin during initial test discovery. Tests
were rerun with `PYTHONPATH` removed, plugin autoload disabled and
`-p anyio.pytest_plugin` explicitly enabled. This is test-environment isolation,
not an application change. Initial runs without the required async plugin are not
passing evidence. 初次测试环境失败没有计为通过。

## Real model acceptance / 真实模型验收

Both models completed real inference, CLI/UI generation, persisted adoption and
reopening. Their registered assets were composed and exported through the existing
production timeline UI. 两种模型的技术交付已验收；创作品质和人类新手试用单独记录。

Fixed model snapshots:

- Z-Image-Turbo: `f332072aa78be7aecdf3ee76d5c247082da564a6`.
- Qwen3-TTS-12Hz-0.6B-CustomVoice: `85e237c12c027371202489a0ec509ded67b5e4b5`.

### TTS / 语音

On 2026-11-09 at 15:25 UTC, the direct verifier returned an MP3 in 6.158 seconds:
24,000 Hz, mono, 8.304 seconds. The synthetic prompt contains Chinese and English,
using builtin voice `vivian`. The first request included additional Triton JIT
work. A 0.5-second whole-device sampler observed 25,144 MiB at its highest sample;
this includes other workloads and is not the service's allocator peak.

Run: `2684dd20-bf5f-468c-a04f-e547646db4d4`.
MP3 SHA256: `95d73db760a3a94b0af6e353954636cf2f3c5c70b09ee8bbad8c700becee9daf`.
中文与英文混合旁白完成真实生成；这些耗时与整卡采样不构成最低显存或稳定吞吐承诺。

The production OpenDirector instance used the existing self-hosted OpenAI speech
adapter through an SSH forward, and read the real builtin voice registry.
Project: `5fa9d117-cd3a-48ec-85a9-e79df0d5cc88`.

| Entry / 入口 | Actual job / 任务 | Registered audio / 登记素材 | Result / 结果 |
| --- | --- | --- | --- |
| CLI | `992e42b1-f1b6-5fb9-ae6f-a7faf04cece0` | `6c15d684-783a-5149-b8ae-5adf07021960` | Technical check passed; adopted; 9.168 s / 技术检查、采用通过 |
| Browser UI | `f9eb970c-5740-50fd-a0f2-624fc6f896d2` | `8d4fbf9e-2292-5bc7-8f47-886b2eaa66f2` | Technical check passed; adopted; 8.616 s in probe / 技术检查、采用通过 |

The CLI executed spec revision 1. The UI continued that same object at revision 2;
its new adoption persisted as revision 3 with result
`23591784-fd11-5d48-9045-3024b89f2862`. Reopening in a new browser context preserved
that identity. After stopping the model service, Chrome still decoded and played
the registered audio to its end (8.56 seconds as reported by the browser,
`ended=true`, no media error). Decoder/container duration estimates differ slightly.
不是占位节点：实际任务输入、素材哈希、采用关系、重开与完整播放均已核对。

During UI acceptance the local SSH model forward exited while the remote model
remained healthy. The application rejected submission with `voice_provider_error`
and zero job IDs; the previously adopted result remained intact. Restoring the
forward allowed a new, explicitly observed UI submission to succeed. No unknown
submission was blindly repeated. 这也验证了实际连接故障、保留产物和恢复路径。

The MP3 was fully decoded by FFmpeg and Chrome; the older FFmpeg decoder emitted
nonfatal MP3 overread warnings. Speech intelligibility, pronunciation and aesthetic
quality still require listening review. This session cannot consume audio input;
it does not count waveform display, non-silence or successful playback as hearing
the result. 听感未审，不能将技术通过写成创作品质认可。

### Image / 图像

On 2026-11-09 at 15:52 UTC, the direct request returned a fully decoded 1344×768
PNG in 2.766 seconds, with 9 steps, CFG 0 and seed 7. The server loaded BF16
weights and reported 20.02 GiB of process-scoped GPU memory after loading.
Whole-device inference sampling observed 49,442 MiB across six samples, including
other workloads. These are distinct scopes and neither is an allocator peak.

Run: `aa20f293-278e-4e0d-a046-b39d739aa1b1`.
PNG SHA256: `5c60fc64877e550330ea50e9f64bbea26634490c409b0de1c23a9f3a6640d83b`.
直接请求与工程生成均验证实际 PNG 解码、尺寸和内容哈希。

| Entry / 入口 | Actual job / 任务 | Registered image / 登记素材 | Result / 结果 |
| --- | --- | --- | --- |
| CLI | `23ebeab1-61c0-57bd-905c-94eb6c527a00` | `16ca632f-5f1b-5fb0-bf54-a44dfce360f0` | Technical check passed; adopted; 1344×768 / 技术检查、采用通过 |
| Browser UI | `7dd207e7-8257-5a23-ae37-0d33fd05c5f0` | `ec357735-a890-5df5-98a8-94196c63b1b7` | Technical check passed; adopted; 1344×768 / 技术检查、采用通过 |

The CLI executed spec revision 2. The UI continued at revision 3 and persisted
revision 4 with result `ddeab2a2-148e-576f-9140-3f0f8edef3f9`. A new browser context
loaded the same result and decoded its 1344×768 image. Earlier CLI output remained
available and its bytes matched its registered fingerprint.

The application baseline omits the smoke probe's sampling overrides; the installed
upstream Z-Image pipeline falls back to 50 steps. Its timing is not comparable to
the explicit 9-step probe. Sampling alignment is tracked separately in
[#230](https://github.com/ThinkFlowLab/OpenDirector/issues/230) /
[#231](https://github.com/ThinkFlowLab/OpenDirector/pull/231); no application adapter
or output contract was changed for this deployment task.

Agent visual review confirmed a red boat, harbor, lighthouse and warm lighting in
the direct, CLI and UI images. The boats appear moored rather than visibly leaving,
and generated hull markings include imperfect text. These observations are not
user creative approval. 已审看真实图像；基本场景存在，离港动作与船身文字仍有创作偏差。

### Composition and persistence / 合成与持久化

The actual generated image and narration were pinned by asset revision and
fingerprint in timeline document `aaea2e3f-8685-4109-b8e4-73a74c3afd19`, revision 1.
The external Agent created it through the normal CLI batch command. The browser
then rendered and registered a video through the production UI, with both model
services stopped. UI-to-CLI handoff initially respected the existing live browser
lease; the same saved command succeeded after its 60-second lease expired.
没有修改工程文件、绕过租约或引入新的渲染服务。

- Rendered asset: `865e67ba-0d23-59bc-b844-b7b0cce9de07`.
- MP4 SHA256: `b590ca447f2e52a4ce22aab37089dc7763a48aca0784c868cfaafa4442ad110a`.
- 232,809 bytes; H.264 640×360, 24 fps, 240 frames; AAC 48 kHz stereo;
  container duration 10.026667 seconds.
- Full FFmpeg decoding passed. An extracted frame showed the generated image.
- Render provenance retained the exact two source assets and editor revision.

This is a static generated image with generated narration, composed by the
existing browser renderer. It does not validate a video-generation model,
background rendering after browser closure, or desktop 1080p encoding.
本例验证真实素材可用于现有时间线；导出仍需浏览器参与。

After a full application process restart, a fresh browser session re-read the
same assets, generation specs, result versions, jobs, editor documents and canvas
items. All five registered files matched their saved SHA256 fingerprints. The
rendered video played to the end (10.026667 s, 640×360, no media error).
应用进程重启后，工程对象、历史结果、采用状态与全部文件均保持，视频完整播放通过。

Consumer laptops, RTX A6000/SM86 real inference, multi-GPU serving, ASR, native
Windows and Apple Silicon are outside these hardware measurements. Budget values
are preflight reservations rather than measured minimums. 面向未熟悉部署的人类用户的首次成功时间、
手动操作与恢复体验，仍需要单独实测，不能用 Agent 试用代替。
