---
name: deploy-vllm-omni
description: Inspect a Linux GPU host, select a compatible vLLM-Omni model recipe, deploy an isolated service, connect OpenDirector and verify real generated assets. Use for self-hosted model setup or deployment repair; ordinary application installation uses install-opendirector.
---

# Deploy vLLM-Omni for OpenDirector

Deliver a reproducible working model connection and actual output. Reply in the
user's language. Follow the user's chosen host, assigned GPU, directory and model.
A discussion or plan alone does not authorize installation or inference; an
authorized deployment-and-validation request does not require confirmation at
each routine step.

Use the installed `opendirector vllm-omni` CLI on the target host. Discover its
options with `opendirector vllm-omni deploy --help` and
`opendirector vllm-omni verify --help`. The application package includes the
profiles and deployment tools; model dependencies belong to an isolated environment.
Read the matching [English guide](../../../docs/guides/vllm-omni.md) or
[Chinese guide](../../../docs/guides/vllm-omni.zh-CN.md) when available.

## Inspect before changing anything

Run `opendirector vllm-omni deploy --root DATA_DIRECTORY doctor` with a Python 3.12 model interpreter on the target host.
The helper is read-only. Resolve SSH aliases using actual SSH configuration, and
record the detected hardware rather than inferring it from an alias. Respect
assigned resources, inherited device visibility and other workloads.

Run `plan` for an explicit physical index or UUID and model profile. Inspect OS,
GPU architecture, driver, free VRAM, available host memory and the relevant data
disk. Multiple cards do not form a larger single GPU. Unknown measurements do not
establish readiness. In particular, the repository's FastH3 NVFP4/SM120 recipe
does not work on an Ampere RTX A6000. Eligibility and measured qualification are
different facts; do not claim support for an untested combination.

## Deploy and observe the original operation

Use `install`, `download`, `start`, `status` and `stop` from the guide. Reuse the
fixed profile and mature uv/Hugging Face mechanisms. Keep runtime data, caches,
logs and outputs under the selected data directory. Use the profile's isolated
environment, preserve existing application configuration and do not change
global drivers or package registries. Choose a reachable trusted mirror only
when needed; keep it scoped to the deployment.
If observed long-transfer failures warrant it, use the guide's range backend,
which reuses the repository's existing pinned downloader. Preserve original
operations and partial files; do not invent another downloader or run duplicate
transports for the same model. Reuse existing weights only after manifest checks.

Observe exit status, readiness and the reported log. A started PID is not ready
inference. `startup_pending` refers to the original possibly loading process;
query it before another action. Preserve conflicting listeners and shared
workloads. After a transient failure retry the same operation once only when
evidence supports it; continued failure requires diagnosis or changed conditions.

## Prove delivery through OpenDirector

Use `opendirector vllm-omni verify` for read-only health/model identity and `opendirector vllm-omni verify --infer` for
one authorized real request. Inspect the PNG or listen to the audio, and report
technical validity separately from creative review. Preserve verification
receipts, exact versions, parameters, artifacts and resource sampling scope.
Inference timeouts are unknown submissions; do not automatically resubmit them.

Connect through Settings → Model access or existing model configuration APIs.
Choose the URL reachable from the OpenDirector backend, which may be on a
different machine from the browser. Keep remote model services on loopback and
use an SSH tunnel for the selected topology.

Finish in an isolated real OpenDirector project using existing business
commands: create generation intent, submit, wait by returned job identity, inspect
the registered asset and adoption state, reopen and continue. Use CLI discovery
and returned next commands; never edit project files or credential storage to
bypass business rules. The `qwen3-asr-06b` companion uses native vLLM in the same
environment; use `opendirector vllm-omni verify --infer --audio-file` for transcription. Reference
text is only a local comparison, never a model hint. OpenDirector has no automatic
ASR tool: register transcripts through existing text-asset commands and describe
this handoff explicitly. Do not treat music-to-score as ASR or invent capabilities
from the provider name. Record unavailable integrations explicitly. Follow the
guide's first-use protocol for a real participant; keep unobserved human feedback
pending and distinguish cached setup from clean installation.

Hand off copyable restart/status/stop commands for the actual host and
data directory, the model connection, measured results and remaining limitations.
Stop test processes you created unless the user requested a running service.
