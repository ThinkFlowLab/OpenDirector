# Contributing

Thanks for helping with OpenDirector. This file covers the issue/PR labels and the checklist we ask for before a change is reviewed. Architecture rules live in [AGENTS.md](AGENTS.md); reproducible checks and evidence requirements live in [docs/development/validation.md](docs/development/validation.md).

## Label taxonomy

Labels are short, English and prefixed by dimension, so issues and PRs can be filtered without reading every title.

### `type:` — exactly one

| Label | Use for |
| --- | --- |
| `type:bug` | Something behaves incorrectly |
| `type:feat` | New capability or behaviour |
| `type:docs` | Documentation-only change |
| `type:refactor` | Internal restructuring, unchanged behaviour |
| `type:ci` | Build, test and release automation |
| `type:meta` | Process, labels, roadmap, repository hygiene |

### `area:` — one or more

| Label | Covers |
| --- | --- |
| `area:canvas` | Canvas, nodes, direct manipulation |
| `area:agent` | Agent runtime, assistant chat, tools |
| `area:harness` | Harness and skill integration (Default, OpenCode, Codex, Claude Code, JiuwenSwarm, DSH) |
| `area:provider` | Model providers and generation protocols |
| `area:assets` | Assets, library, reference inputs |
| `area:timeline` | Timeline, subtitles, export |
| `area:install` | Install, startup, environment support |
| `area:i18n` | Localisation and bilingual UI |
| `area:ci` | Continuous integration and checks |

### `modality:` and `provider:` — only when relevant

`modality:image`, `modality:video`, `modality:audio` describe what the work produces.
`provider:minimax`, `provider:moss`, `provider:openai`, `provider:flux`, `provider:kling`, `provider:runway`, `provider:google` name the external service. Use `provider:openai` for OpenAI and any OpenAI-compatible service only when OpenAI itself is the subject.

### `priority:` — maintainers only

`priority:p0` blocks the agreed release scope, `priority:p1` is scheduled next, `priority:p2` is accepted but unscheduled. Contributors do not need to pick one; a maintainer applies it after triage.

### Process labels

- `needs-design` — a visual or product decision is still open.
- `needs-repro` — the report has no reproducible case yet.
- `blocked` — external input, credentials or a decision is missing.
- `good first issue`, `help wanted` — community entry points, as on GitHub by default.
- `ready` — triggers the release-checks workflow on a pull request; do not use it to mean "reviewed".

The default GitHub labels `bug`, `enhancement` and `documentation` were retired in favour of `type:bug`, `type:feat` and `type:docs`. `duplicate`, `invalid`, `question`, `wontfix` and `accessibility` remain available.

## Picking labels

- An issue gets one `type:`, every `area:` it touches, and a `modality:` / `provider:` pair only when the work is specific to that service.
- A pull request carries at least one `type:` and one `area:` label, so the change appears in both filters.
- When a label does not fit, open an issue with `type:meta` and propose the new dimension instead of inventing a free-form tag.

## Pull request checklist

1. Scope stays in one concern; unrelated refactors go to a separate PR.
2. Behaviour changes come with a test that fails on the previous revision, not just a test that passes now.
3. Docs under `docs/` are updated in the same change when objects, API fields, model parameters or save/recovery semantics move. Update the index in [docs/README.md](docs/README.md) when adding a page.
4. Never claim real-provider verification you did not run. State what was validated with a model double, what needs credentials, and what remains unverified.
5. Credentials, private assets and raw provider responses never enter commits, fixtures, logs or receipts.
6. Run the checks from [docs/development/validation.md](docs/development/validation.md) locally, or make it explicit which ones you could not run.
