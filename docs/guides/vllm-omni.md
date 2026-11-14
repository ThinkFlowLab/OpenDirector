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
Repeated `start` does not launch another live instance; it requires the same
profile, port and explicitly selected GPU within the current device visibility.
Use `--port` before `start` to select a free port. `stop` only signals the recorded process group after checking
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

## ASR companion service

The `qwen3-asr-06b` profile pins Qwen3-ASR-0.6B (about 1.88 GB) in the same
isolated environment. It uses **native vLLM 0.32.0**, which implements this model's
OpenAI transcription endpoint. It does not add an Omni pipeline. Run the normal
`plan`, `download`, `start`, `status` and `stop` commands with
`--profile qwen3-asr-06b`; use `--port 8093` at startup. The 16 GiB GPU budget is a
preflight reservation, not a measured hardware minimum. The profile limits engine
memory utilization to 0.10, sequence length to 4096 and concurrent sequences to 4.
The pinned image and TTS recipes continue using `--omni`.

```sh
python3.12 tools/vllm_omni/verify.py --root "$OMNI_ROOT" --profile qwen3-asr-06b
python3.12 tools/vllm_omni/verify.py --root "$OMNI_ROOT" --profile qwen3-asr-06b \
  --infer --audio-file /path/to/authorized-recording.mp3 \
  --expected-text 'The known recording transcript'
```

Read-only verification needs no audio. Inference accepts WAV, MP3, FLAC, M4A,
OGG, WebM or MP4 up to 25 MiB and saves the exact uploaded bytes, their SHA256,
media facts, raw JSON output and recognized text. `--expected-text` is optional
and **never sent to the model**. Comparison reports character edit distance and
error rate after NFKC normalization, case folding and removal of punctuation and
spaces; both normalized strings are limited to 4096 characters. This is a
content check, not a pronunciation, listening or general ASR benchmark score.
Keep authorized recordings and transcripts private; receipts contain their text.

OpenDirector currently has no speech-to-text model preset or automatic ASR tool.
Do not configure ASR as the music-to-score model or a speech synthesizer. An
external Agent can call this verifier and use the existing `asset write-text`
and `canvas add-material` commands to register its transcript in the project.
Users can inspect that text and continue editing through the existing UI. This
manual handoff does not claim an in-application ASR integration. The selected
Qwen3-TTS CustomVoice checkpoint also rejects uploaded voice cloning; a transcript
does not change its supported capabilities.

## First-use participant trial

Use a real participant unfamiliar with this deployment. Before starting, record
their experience, OS, host, assigned GPU, checkout revision, network route, and
whether weights, environment or compilation caches already exist. A trial using
cached weights measures an assisted cached setup, not a clean installation.

Give the participant the deployment skill and this guide. Ask them to inspect the
host, select an eligible recipe, start the service, connect OpenDirector, produce
one asset and reopen the project. Let them make ordinary decisions; record every
manual action and help intervention. If exercising recovery, stop only their own
SSH forward, observe the readable failure and preserved asset, restore it, and
query the original operation before any new attempt. Never interrupt shared jobs.

Record timestamps for start, ready service, direct inference and first usable
project asset; count manual actions, help requests, retries and recovery time.
Ask the participant to inspect the image or actually listen to the audio and
report omissions, pronunciation, noise, naturalness and suitability. Record
technical result, participant observations and creative approval separately.
Leave unanswered fields pending; an Agent run, successful playback or ASR match
cannot supply human observations.

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
| `audio_input_required`, `audio_input_unreadable`, `unsupported_audio_format`, `invalid_audio_input_size` | Supply a readable ASR input in a supported format, nonempty and at most 25 MiB. |
| `invalid_comparison_text`, `comparison_requires_transcription` | Use a nonempty ASR reference with at most 4096 normalized characters; the option is only for transcription. |
| `inference_result_unknown` | Inspect the saved receipt and server before deciding whether to start a new attempt. |
