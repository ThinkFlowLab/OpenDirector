# Deploy local models with vLLM-Omni

[中文](vllm-omni.zh-CN.md)

Use these optional tools on a Linux x86_64 GPU host with Python 3.12. OpenDirector
and the model server have separate environments. Install OpenDirector using the
[installation guide](installation.md); installing the application does not deploy
models. See [validation evidence](../development/vllm-omni-validation.md) for the
configurations actually exercised. Eligibility is not a claim that an untested
GPU is supported.
The host needs an existing C++ compiler for CUDA JIT compilation, and `ffmpeg` /
`ffprobe` for media checks. The helpers do not install system packages.

For Agent assistance, load the repository's
[deployment skill](../../.agents/skills/deploy-vllm-omni/SKILL.md) in an external
coding Agent with authorized shell/SSH access. It follows the existing
installation skill's source-checkout workflow. The deployment helpers and this
skill are repository resources, separate from the application's bundled creative
skills; installing the Python application alone does not ship these helpers.

## Inspect and select

Run from the checkout. Choose a data disk with room for weights, the CUDA environment,
caches and outputs. `doctor`, `plan` and `status` do not create directories or submit
inference. An index refers to a physical device in `nvidia-smi`; use the returned
UUID for subsequent operations. Respect the server's resource allocation and inherited
`CUDA_VISIBLE_DEVICES`. Free memory alone does not allocate a shared GPU to you.
If Python 3.12 is installed outside PATH, replace `python3.12` in these commands
with that interpreter's absolute path. The model venv uses that interpreter by default.

```sh
OMNI_ROOT=/path/to/data/opendirector-models
python3.12 tools/vllm_omni/deploy.py --root "$OMNI_ROOT" doctor
python3.12 tools/vllm_omni/deploy.py --root "$OMNI_ROOT" --gpu GPU-UUID plan
```

The bundled `zimage-bf16` profile fixes a Z-Image-Turbo snapshot and the matching
vLLM / vLLM-Omni 0.32.0 combination. It downloads about 32.85 GB. `qwen3-tts-06b`
uses a 0.6B CustomVoice snapshot (about 2.50 GB). Resource budgets are conservative
preflight reservations, not measured minimums. An existing matching environment
and cached weights reduce the additional storage budget.

The separate [FastH3 recipe](../../tools/fasth3/README.txt) requires Blackwell SM120
and NVFP4 kernels. Its validation does not cover Ampere RTX A6000 cards. Do not
infer compatibility from a similar GPU name or add multiple cards' memory together.

## Install, download and start

Use the same root and GPU for each command. Installation creates `omni-env` under
the chosen root, verifies dependencies and runs a small CUDA operation and a real
FlashInfer sampling kernel. Compiler, CRT and NVVM versions are fixed at 13.0.88
to match the cu130 runtime. The helper discovers the environment's compiler and
creates a private linker alias for the runtime library; it preserves an explicitly
selected `CUDA_HOME`/`CUDA_PATH`. Downloads
use Hugging Face's cache/locks/resume support, a fixed revision and file hashes.
No model service starts during installation or downloading.

```sh
python3.12 tools/vllm_omni/deploy.py --root "$OMNI_ROOT" --gpu GPU-UUID install
python3.12 tools/vllm_omni/deploy.py --root "$OMNI_ROOT" --gpu GPU-UUID download
python3.12 tools/vllm_omni/deploy.py --root "$OMNI_ROOT" --gpu GPU-UUID start
python3.12 tools/vllm_omni/deploy.py --root "$OMNI_ROOT" status
```

To select a mirror, add `--hf-endpoint https://your-trusted-mirror` before the
command. It is scoped to this deployment. Keep the cache on the data disk; avoid
multiple downloads of the same snapshot. A failed download preserves SDK resume
files. Investigate its status and network condition before retrying the same
command. The tool does not change a global package index, driver or CUDA install.
The SDK chooses its transfer backend. If your selected network cannot access Xet,
set `HF_HUB_DISABLE_XET=1` for that process; the tool preserves this setting.
For a network with persistently slow or failing long transfers, add
`--download-backend ranges` to `download`. This reuses
`tools/fasth3/download_models.py` with an explicit complete manifest, preserving
its original FastH3 defaults. Keep that file alongside `tools/vllm_omni` when
copying tools to a remote host. `DOWNLOAD_WORKERS=16` bounds concurrent ranges;
proxy settings and the selected endpoint remain scoped to this process. Completed
files and range journals are preserved. Do not run two transports concurrently
for the same model. Existing weights may be copied into the selected profile's
range directory and are verified before reuse; never rename a different checkpoint
to make it appear compatible.

Startup binds `127.0.0.1:8091`, records the owned process, and waits for health
and the exact Model ID. `startup_pending` means the original process may still be
loading: query `status` and inspect the reported log before taking another action.
Repeated `start` does not launch another live instance. Use `--port` before `start`
to select a free port. `stop` only signals the recorded process group after checking
its owner and process start identity.
`status` describes only the model service; `stopped` does not mean that a separate
installation or download process has finished.
Compilation caches for vLLM, TorchInductor, Triton and FlashInfer also stay under
the selected data directory; no shared home-directory cache is required.

```sh
python3.12 tools/vllm_omni/deploy.py --root "$OMNI_ROOT" stop
```

For TTS add `--profile qwen3-tts-06b` to the commands and use `--port 8092` for
startup. Stop the image model first when validating resource use in isolation.
The TTS configuration comes from the installed upstream pipeline, with per-stage
memory utilization 0.15 and maximum sequences 4. The 0.6B CustomVoice checkpoint
uses built-in speakers such as `vivian`; cloning requires a different Base model.
Initial compilation and graph capture can exceed the upstream 300-second stage
deadline. This profile allows 1200 seconds; use `--timeout 1500 start` to extend
the helper's observation window. An observation timeout requires querying the
original process before another action.

## Verify actual output and connect OpenDirector

```sh
# Health and model identity only; no inference or output files.
python3.12 tools/vllm_omni/verify.py --root "$OMNI_ROOT"
# One real request, saved output, decoding and a verification receipt.
python3.12 tools/vllm_omni/verify.py --root "$OMNI_ROOT" --infer
python3.12 tools/vllm_omni/verify.py --root "$OMNI_ROOT" --profile qwen3-tts-06b --infer
```

Inspect the PNG and listen to the MP3. Technical validation leaves creative review
pending. Receipts include fixed request parameters, model revision, file hash,
elapsed time and sampled whole-device memory. Those samples include other workloads
and are not process allocator peaks. A timeout preserves an unknown-submission
receipt and never automatically resubmits inference.

In Settings → Model access select the image or speech vLLM-Omni preset, self-hosted,
no authentication, the exact Model ID in the profile, and the reachable API base
ending in `/v1`. Use `proxyMode: direct` for a loopback tunnel. Configure through
the existing UI or `/api/model-configs` API, not by editing `models.json`.

If both services run on the GPU host, the model URL is `http://127.0.0.1:8091/v1`
and forward OpenDirector's port to the browser machine. If OpenDirector runs on
your computer and Omni runs remotely, forward the model port:

```sh
ssh -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -N -L 18091:127.0.0.1:8091 YOUR_GPU_HOST
```

Then the model URL is `http://127.0.0.1:18091/v1`. `localhost` always refers to
the machine running the OpenDirector backend, not necessarily the browser.

Finish with an OpenDirector generation: create a project and generation item,
submit through existing commands, wait on the returned job identity, inspect the
registered asset and adoption state, and reopen the project. Use CLI `--help` and
the next command in the receipt instead of inventing image/TTS convenience commands.
Keep model-list readiness, direct inference, project delivery and creative approval
as separate results. ASR is a separate integration; the music-to-score preset is
not speech transcription. Z-Image sampling alignment is tracked in [#230](https://github.com/ThinkFlowLab/OpenDirector/issues/230)
and [#231](https://github.com/ThinkFlowLab/OpenDirector/pull/231); compare performance
only with matching actual request parameters.

## Failure codes

Commands emit JSON and exit 1 on a blocked plan or failure; argument errors exit 2.

| Code | Next step |
| --- | --- |
| `gpu_probe_failed`, `gpu_probe_incomplete` | Check NVIDIA driver visibility and `nvidia-smi`; missing data is not zero usage. |
| `gpu_selection_required`, `gpu_visibility_unresolved` | Select an assigned physical index or UUID within the existing visibility. |
| `unsupported_gpu_architecture`, `driver_too_old` | Select a compatible recipe/environment; retain existing system drivers. |
| `insufficient_free_vram`, `insufficient_host_memory`, `insufficient_disk_space` | Use allocated resources with sufficient headroom; budgets are not minimum-hardware claims. |
| `model_download_failed`, `model_file_invalid` | Check the fixed snapshot, mirror and available space; preserve partial files and inspect invalid files. |
| `port_in_use`, `running_configuration_conflict` | Preserve the listener; select a different port or stop the owned deployment before changing it. |
| `server_exited`, `startup_pending` | Inspect the reported log and original process; do not start duplicate model loads. |
| `cuda_linker_conflict` | Inspect the reported private runtime-library alias; preserve the conflicting file before correcting its target. |
| `served_model_mismatch` | Correct the endpoint or served model identity; health alone does not establish compatibility. |
| `service_not_started` | Run `status`/`start`, or supply `verify.py --url` for an existing service. |
| `inference_result_unknown` | Inspect the saved receipt and server before deciding whether to start a new attempt. |
