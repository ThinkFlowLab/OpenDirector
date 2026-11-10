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
| `area:performance` | Performance and responsiveness / 性能与响应速度 |
| `area:docs` | Documentation / 文档 |
| `area:desktop` | Desktop integration / 桌面集成 |

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

## Automatic reviewer requests / 自动邀请审查人

Edit [`.github/reviewer-routing.json`](.github/reviewer-routing.json) to maintain label-to-reviewer mappings and the fallback list. Open, ready-for-review, reopened and label-change events invite **all** owners of all matching labels, deduplicated. The PR author, already requested reviewers and people who submitted a review are excluded. With no matching label, all fallback reviewers are considered; a matched label whose only owner is the author does not activate fallback. Drafts are skipped. Existing invitations are never removed, including after label removal. Removing a label never adds fallback reviewers when no mapped labels remain. New commits do not re-request review. Existing PRs need a label change or reopening to trigger routing after installation.

修改 [`.github/reviewer-routing.json`](.github/reviewer-routing.json) 维护标签与审查人的映射及默认名单。PR 创建、转为可审查、重开或标签变化时，邀请所有匹配标签的全部负责人并去重，排除作者、已邀请及已提交审查的人。无标签匹配时使用全部默认候选；匹配标签的唯一负责人是作者时，不启用默认名单。草稿跳过，已有邀请始终保留，移除标签也不撤回邀请；移除后无匹配标签时不追加默认审查人，新提交不重复邀请。功能安装后，已有 PR 需修改标签或重开才能触发。

The same configuration's `labels` list declares new labels. A push to main affecting the routing files, or a manual workflow dispatch, creates missing labels without updating or deleting existing ones. To change an existing label's color or description, use GitHub's Labels page. Reviewer accounts must be eligible for review requests in this repository; an unavailable account produces a warning while remaining candidates are still requested. API permission failures fail the job. No live review invitations are sent by local tests.

配置中的 `labels` 列表声明新增标签。路由文件合入 main 或手动运行工作流后，补建缺少的标签，不修改或删除已有标签。修改已有标签的颜色或说明请使用 GitHub Labels 页面。候选账号必须具有仓库审查邀请资格；无法邀请的账号会产生警告，其余候选继续处理；API 权限错误使任务失败。本地测试不发送真实邀请。

The privileged workflow only checks out the PR base commit, never the contributor's head, and executes no PR-supplied code. Validate changes with `node --test tests/reviewerRouting.test.ts`.

具有写权限的工作流只检出 PR 的目标分支提交，不检出或执行贡献者分支代码。修改后运行 `node --test tests/reviewerRouting.test.ts` 验证。

## Pull request checklist

1. Scope stays in one concern; unrelated refactors go to a separate PR.
2. Behaviour changes come with a test that fails on the previous revision, not just a test that passes now.
3. Docs under `docs/` are updated in the same change when objects, API fields, model parameters or save/recovery semantics move. Update the index in [docs/README.md](docs/README.md) when adding a page.
4. Never claim real-provider verification you did not run. State what was validated with a model double, what needs credentials, and what remains unverified.
5. Credentials, private assets and raw provider responses never enter commits, fixtures, logs or receipts.
6. Run the checks from [docs/development/validation.md](docs/development/validation.md) locally, or make it explicit which ones you could not run.
7. For a user-visible change, attach screenshots or a short demo in the pull request, or mark N/A with a reason, as asked in the evidence section of the [pull request template](.github/pull_request_template.md).
