# Multimodal model connections

## 摘要（中文）

同一 API Key 往往同时提供语言、图片、视频、语音模型，但当前配置流程是「按模态建服务」：语言、图片、视频、音频各填一次地址与密钥、各自发现模型、各自保存。本文设计「连接（connection）」为第一次类对象：一次填写地址与凭据，按模态分别发现并分组的模型，一次保存为多个 `model-configs`（同一 `providerId`），并对部分失败、能力检查、协议差异和兼容性给出明确语义。本文只描述设计，不代表已实现。

Status: implemented for the settings entry point; the first-run wizard and the business CLI still use the per-kind form (see “Delivered scope”).

## Delivered scope

Implemented in this repository:

- `POST /api/model-configs/discover-many` and `POST /api/model-configs/connections`, backed by
  `ModelCatalog.discover_many` / `ModelCatalog.save_connection` (`packages/core/src/opendirector/application/model_catalog.py`)
  and `ModelConfigs.save_connection` (`packages/core/src/opendirector/infrastructure/model_configs.py`).
- Per-kind saving now replaces only rows of that kind, so a connection can grow kind by kind without
  dropping its peers (`save_many` filters `previous` by kind).
- `src/canvas/ModelConnectionForm.tsx`, reachable from Settings → model connections →
  “Add a connection (multi-modal)” and from the per-kind service list.
- Tests: `tests/test_model_catalog.py` (discovery isolation), `tests/test_model_configs.py`
  (one providerId across kinds, partial failure, retry reusing the connection, rejected input) and the
  browser workflow `tests/browser/model_connection.mjs`.

Not delivered yet: first-run wizard entry, CLI/agent tool parity, reusing an existing connection to add
only a missing kind from the settings list, and translating the panel into the per-kind forms.

## Problem

Configuration is currently kind-scoped end to end:

- UI: `src/canvas/ModelServiceForm.tsx` holds one `kind`; entering the first-run wizard for a MiniMax account with text, image, video and speech models means repeating the same URL and key four times.
- Discovery: `POST /api/model-configs/discover` takes a single `kind` and derives one protocol via `connection_fields()` (`packages/core/src/opendirector/domain/model_connection.py`), so `/models` is read under one protocol only.
- Save: `POST /api/model-configs/batch` accepts one `kind` plus `modelIds` (`apps/api/src/opendirector_api/main.py`).

The storage layer already models the missing concept: `providerId` groups configurations of different kinds that share `url`, `apiKey`, `connectionType`, `authMode` and `proxyMode` (`packages/core/src/opendirector/infrastructure/model_configs.py`). Today a user can only reach a shared connection by editing an existing configuration, never by creating one.

## Goals

1. One form fills address, authentication, proxy mode, capability-check policy, then adds models for several kinds in one pass.
2. Everything saved in that pass belongs to one `providerId`, so later credential edits apply to all kinds.
3. Model ability remains per-kind: a connection is not a claim that every model supports every operation.
4. Partial success is explicit: the user sees which kinds saved, which were rejected and why, and can retry only the failed part.
5. UI, CLI and agent tools keep using the same application service; no entry point gets a private shortcut.

Non-goals: automatic protocol guessing for self-hosted servers, cross-kind capability inference from model names, credential storage changes, migration of existing configurations.

## Object model

```
Connection (draft or stored providerId)
  url, apiKey, connectionType, authMode, proxyMode, capabilityAutoCheck
  └── KindEntry (kind, protocol, modelIds[])          # one per kind in this pass
        └── ModelConfig (existing object, unchanged)   # id, kind, modelId, protocol, ...
```

- A connection is identified by `providerId` only after the first successful save; drafts never persist identity.
- `protocol` stays on the kind entry, not on the connection: `openai` for agent/image/audio and `minimax_video_v2`/`kling_video`/`bigmodel_video`/`vllm_omni` for video are not interchangeable.
- A connection may exist with only some kinds configured. Missing kinds are absent, not empty.

## Discovery

For each kind the client asks the server to discover models for that kind's candidate protocol:

- `openai` kinds use `GET {url}/models` through `read_service_models()` (`packages/core/src/opendirector/integrations/model_capabilities.py`).
- Built-in-declaration protocols (`minimax_video_v2`, `kling_video`, `bigmodel_video`, `higgsfield_open`) return the declared list without a network call, as they do today.
- Model ids that appear in several kinds are kept per kind; a shared id is not evidence of shared input rules.

New endpoint: `POST /api/model-configs/discover-many` with `{url, apiKey, connectionType, authMode, proxyMode, kinds: [{kind, protocol}]}` returning
`{results: [{kind, protocol, models: [id], error: null | {code, message}}]}`.

Rules:

- One kind failing does not abort the others; each result carries its own error.
- Total discovery is bounded (kinds requested, response sizes, timeout) so a hung upstream cannot block the form.
- The draft is never written to disk; a failed discovery leaves configuration untouched (same contract as `read_service_models` today).

## Save

New endpoint: `POST /api/model-configs/connections` with
`{url, apiKey, connectionType, authMode, proxyMode, capabilityAutoCheck, providerId?, entries: [{kind, protocol, modelIds, modelOptions?}]}`.

Server behavior:

1. Validate the connection once (`model_fields`, `connection_fields` per entry).
2. Allocate or reuse `providerId`.
3. Save each entry through the existing `save_many()` path so per-kind rules, duplicate checks and capability declarations still apply.
4. Apply the connection fields to every peer carrying that `providerId`, as `save()` already does.
5. Return `{providerId, saved: [ModelConfig], rejected: [{kind, code, message}], remaining: [...]}`.

Failure semantics: entries are independent commits. A rejected entry (invalid model id, missing capability declaration, key rejected for that kind) does not roll back the saved ones; the response reports both sets and the UI offers "retry failed kinds" which reuses the same connection fields. This must not be described as all-or-nothing success.

Idempotency: the request carries an operation id; replaying it with identical input returns the original receipt, and replaying it with different input is rejected, consistent with other mutations.

## Capability checks

- `capabilityAutoCheck` stays a connection-level default but each model keeps its own availability record (`docs/guides/model-availability.md`).
- A saved model never blocks on capability probing; probing failure produces an explainable unavailable state, not a failed save.
- Video entries keep explicit `videoCapabilities` requirements; a connection with video models still needs output declarations or manual configuration.

## UI flow

1. `添加服务` becomes `添加连接`: provider preset, address, auth, proxy, capability-check policy.
2. `获取模型` runs discovery for every supported kind in one request; results render as collapsible kind sections with per-kind counts and errors.
3. Selecting models across sections enables one `保存连接` action; the footer reports `将启用 N 个模型（语言 x、图片 y、视频 z）`.
4. Save result screen lists saved kinds and rejected kinds with reasons, each with `重试` and `编辑`.
5. First-run wizard (`src/canvas/WelcomeScreen.tsx`) reuses the same component: after saving, the task step only asks for kinds the connection did not provide.
6. Settings → model access lists connections with their kinds, so the user can add a missing kind to an existing connection instead of creating a duplicate service.

Existing single-kind editing stays available for configurations that are not part of a connection and for self-hosted servers.

## Bilingual and accessibility

- Every new message key ships in `zh-CN` and `en-US`; stable values (`providerId`, kind ids, protocol ids) are never translated.
- Kind counts and partial-failure summaries use plural messages, not string concatenation.
- The save footer and the partial-failure list are announced via `role="status"`/`role="alert"`; focus moves to the first rejected entry.

## Testing

- Application tests: connection save creates one `providerId` across kinds; credential edit propagates to peers; duplicate model ids within a kind rejected; partially failing entries report saved/rejected sets and stay retryable.
- Discovery tests: one kind returning HTTP 401 while another succeeds; built-in declaration protocols skip the network; oversized responses rejected.
- Browser workflow: `tests/browser/first_run.mjs`-style isolated journey that configures text+image through one connection and asserts the assistant and image selections point at different kinds of the same `providerId`.
- CLI/agent parity: creating the same connection through the business CLI produces identical configuration rows.

## Compatibility and rollout

- Existing per-kind endpoints and configurations keep working; no migration, no rewriting of stored `providerId` values.
- The new connection entry point ships behind the same capability contract, so agent tools and CLI gain it only after the application service exists.
- Open question: whether `audio` and `vision` kinds should appear in the default multi-kind discovery, or only after the user picks a task that needs them.
