# 使用 vLLM-Omni 部署本地模型

[English](vllm-omni.md)

本流程面向 Linux x86_64、Python 3.12 的 GPU 主机。OpenDirector 与模型服务使用独立环境。
应用安装参见[安装指南](installation.zh-CN.md)；安装应用本身不会部署模型。
[验收记录](../development/vllm-omni-validation.md)列出实际测试组合。通过资源预检不代表未测试硬件已获支持。
主机需已有用于 CUDA JIT 编译的 C++ 编译器，以及媒体检查所需的 `ffmpeg` / `ffprobe`；工具不安装系统软件包。

需要 Agent 协助时，在具备已授权 shell/SSH 访问的外部编程 Agent 中加载仓库的
[部署技能](../../.agents/skills/deploy-vllm-omni/SKILL.md)，沿用已有安装技能的源码流程。
该技能与部署脚本作为仓库资源交付，与应用内置创作技能分开；仅安装 Python 应用不会附带这些脚本。

## 探测与选择

在源码根目录执行。数据目录应能容纳权重、CUDA 环境、下载缓存、临时文件和输出。
`doctor`、`plan`、`status` 不创建目录，也不调用生成模型。索引对应 `nvidia-smi` 的物理设备，
后续操作建议使用返回的 UUID。遵守共享服务器的资源分配和已有 `CUDA_VISIBLE_DEVICES`，空闲显存不等于已分配资源。
如果 Python 3.12 已安装但不在 PATH 中，将命令里的 `python3.12` 换成该解释器的绝对路径；模型虚拟环境默认使用这个解释器。

```sh
OMNI_ROOT=/path/to/data/opendirector-models
python3.12 tools/vllm_omni/deploy.py --root "$OMNI_ROOT" doctor
python3.12 tools/vllm_omni/deploy.py --root "$OMNI_ROOT" --gpu GPU-UUID plan
```

默认 `zimage-bf16` 配方固定 Z-Image-Turbo 快照和配套的 vLLM / vLLM-Omni 0.32.0，
模型文件约 32.85 GB。`qwen3-tts-06b` 使用 0.6B CustomVoice 快照，约 2.50 GB。
资源预算是保守的预检预留量，不是测出的最低配置。已存在的匹配环境和缓存权重会减少新增磁盘预算。

独立的 [FastH3 配方](../../tools/fasth3/README.txt)要求 Blackwell SM120 和 NVFP4 内核，
其验收不覆盖 Ampere RTX A6000。不能仅凭名称相近判断兼容，也不能将多卡显存直接相加。

## 安装、下载与启动

每条命令沿用同一数据目录及分配的 GPU。安装在数据目录下创建 `omni-env`，检查依赖完整性并执行小型 CUDA 运算。
安装还会编译并运行真实的 FlashInfer 采样内核。编译器、CRT 和 NVVM 固定为与 cu130 运行时匹配的 13.0.88；
工具发现独立环境内的编译器，并在数据目录下创建运行库的私有链接别名，保留显式指定的 `CUDA_HOME`/`CUDA_PATH`。
下载复用 Hugging Face 的缓存、锁和续传机制，固定 revision 并核对文件哈希。安装和下载阶段不启动模型服务。

```sh
python3.12 tools/vllm_omni/deploy.py --root "$OMNI_ROOT" --gpu GPU-UUID install
python3.12 tools/vllm_omni/deploy.py --root "$OMNI_ROOT" --gpu GPU-UUID download
python3.12 tools/vllm_omni/deploy.py --root "$OMNI_ROOT" --gpu GPU-UUID start
python3.12 tools/vllm_omni/deploy.py --root "$OMNI_ROOT" status
```

如果需要镜像，在命令前添加 `--hf-endpoint https://your-trusted-mirror`，只对本次部署生效。
缓存应放在数据盘上，同一快照避免并发重复下载。失败后保留 SDK 续传文件，先检查错误状态与网络条件，再重试原命令。
工具不修改全局包索引、驱动或系统 CUDA。
传输方式由 SDK 选择；如果当前网络无法访问 Xet，可为该进程设置 `HF_HUB_DISABLE_XET=1`，工具会保留这个设置。
长连接持续过慢或失败时，可为 `download` 增加 `--download-backend ranges`，复用
`tools/fasth3/download_models.py` 的完整清单下载模式，保留它原来的 FastH3 默认行为。
向远端复制工具时，也应保留这个文件。通过 `DOWNLOAD_WORKERS=16` 限定并行分段数，
代理和端点仍只对当前进程生效。保留已完成文件和分段日志，同一模型不要并发运行两种传输。
已有权重可复制到该配方的分段下载目录，通过校验后复用；不能把其他检查点改名冒充当前模型。

服务默认绑定 `127.0.0.1:8091`，记录本次启动的进程，并等待健康检查与目标 Model ID。
`startup_pending` 表示原进程可能仍在加载，应查询 `status` 和回执中的日志，不要重复启动。
通过 `--port` 指定其他空闲端口。停止前会核对进程所有者和启动身份，只向记录的进程组发送停止信号。
`status` 只描述模型服务；返回 `stopped` 不代表另一个安装或下载进程已经结束。
vLLM、TorchInductor、Triton 和 FlashInfer 的编译缓存也保存在所选数据目录下。

```sh
python3.12 tools/vllm_omni/deploy.py --root "$OMNI_ROOT" stop
```

部署 TTS 时，各命令增加 `--profile qwen3-tts-06b`，启动使用 `--port 8092`。
需要独立测量资源时，先停止图片模型。TTS 复用已安装上游流水线，逐阶段显存比例设为 0.15、最大序列数设为 4。
CustomVoice 使用 `vivian` 等内置音色；声音克隆需要不同的 Base 模型。
首次编译和图捕获可能超过上游默认的 300 秒。配方将阶段初始化期限设为 1200 秒；
可通过 `--timeout 1500 start` 延长工具的观察窗口。观察超时后先查询原进程，不重复启动。

## 验证真实产物并连接 OpenDirector

```sh
# 只检查服务健康与模型身份，不推理、不写输出。
python3.12 tools/vllm_omni/verify.py --root "$OMNI_ROOT"
# 提交一次真实生成，保存产物、解码并记录验证回执。
python3.12 tools/vllm_omni/verify.py --root "$OMNI_ROOT" --infer
python3.12 tools/vllm_omni/verify.py --root "$OMNI_ROOT" --profile qwen3-tts-06b --infer
```

请查看 PNG、试听 MP3。技术校验通过后，创作品质仍标为待审。
回执保留实际请求参数、模型 revision、文件哈希、耗时和整卡显存采样。
整卡数据包含其他负载，不能当作本服务的分配器峰值。推理超时会保留提交结果未知的回执，不自动重发。

在设置 → 模型接入中选择 vLLM-Omni 图片或语音接口、自部署服务、无需鉴权，填写配方里的准确 Model ID 和可访问的 `/v1` 地址。
对回环隧道使用直连代理模式。通过现有界面或 `/api/model-configs` 配置，不直接修改 `models.json`。

两个服务均在 GPU 主机时，模型地址为 `http://127.0.0.1:8091/v1`，将 OpenDirector 端口转发给浏览器所在电脑即可。
OpenDirector 在个人电脑、Omni 在服务器时，转发模型端口：

```sh
ssh -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -N -L 18091:127.0.0.1:8091 YOUR_GPU_HOST
```

此时模型地址为 `http://127.0.0.1:18091/v1`。`localhost` 指向 OpenDirector 后端所在机器，不一定是浏览器所在机器。

最终还应在 OpenDirector 新建工程和生成节点，通过现有命令提交、按返回身份等待任务，核对素材登记与采用状态，并重开工程。
CLI 参数以 `--help` 和业务回执里的下一步命令为准，不自行猜测图片或 TTS 便捷命令。
分别记录服务就绪、直接推理、工程交付与创作品质验收。音乐“扒谱”不是 ASR。
Z-Image 采样参数对齐见 [#230](https://github.com/ThinkFlowLab/OpenDirector/issues/230)、[#231](https://github.com/ThinkFlowLab/OpenDirector/pull/231)，
性能比较必须使用一致的实际请求参数。

## 失败代码

工具输出 JSON，预检阻断或执行失败退出 1，参数错误退出 2。

| 代码 | 下一步 |
| --- | --- |
| `gpu_probe_failed`、`gpu_probe_incomplete` | 检查 NVIDIA 驱动及 `nvidia-smi`；缺失数据不能按零占用处理。 |
| `gpu_selection_required`、`gpu_visibility_unresolved` | 在已有可见设备和分配范围内选择物理索引或 UUID。 |
| `unsupported_gpu_architecture`、`driver_too_old` | 选择兼容配方或环境，保留现有系统驱动。 |
| `insufficient_free_vram`、`insufficient_host_memory`、`insufficient_disk_space` | 使用有足够余量的已分配资源；预算不是最低硬件承诺。 |
| `model_download_failed`、`model_file_invalid` | 检查固定快照、镜像与空间，保留断点并核查无效文件。 |
| `port_in_use`、`running_configuration_conflict` | 保留已有监听，换端口，或先停止本工具管理的部署再改配置。 |
| `server_exited`、`startup_pending` | 检查回执中的日志与原进程，不重复加载模型。 |
| `cuda_linker_conflict` | 检查回执中的私有运行库链接，保留冲突文件，再纠正链接目标。 |
| `served_model_mismatch` | 核对地址与模型身份；健康检查不能证明模型匹配。 |
| `service_not_started` | 先运行 `status`/`start`，或为现有服务指定 `verify.py --url`。 |
| `inference_result_unknown` | 查阅保存的回执和服务端情况，再决定是否发起新尝试。 |
