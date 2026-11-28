# Contributing

Thanks for helping with OpenDirector. This file covers the issue/PR labels and the checklist we ask for before a change is reviewed. Architecture rules live in [AGENTS.md](AGENTS.md); reproducible checks and evidence requirements live in [docs/development/validation.md](docs/development/validation.md). Tag and daily release practice lives in [docs/development/release.md](docs/development/release.md).

## Before opening a PR / 提出 PR 前

Install the lightweight static hooks and run the full PR-diff check described in the [validation guide](docs/development/validation.md#pr-前轻量静态检查--lightweight-checks-before-a-pr). Fix failures before opening the PR. Local checks supplement the existing CI and relevant tests.

提出 PR 前，按[验证指南](docs/development/validation.md#pr-前轻量静态检查--lightweight-checks-before-a-pr)安装轻量静态 hook 并检查整个 PR 差异，修复失败后再提出 PR。本地检查与现有 CI、相关测试配合使用。

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

### `priority:` — automatic initial triage, maintainer authority / 自动初判，维护者裁定

`priority:p0` blocks the agreed release scope, `priority:p1` is scheduled next, `priority:p2` is accepted but unscheduled. Contributors do not need to pick one. Issue automation may add an initial priority when supported by evidence; maintainers retain authority and existing priorities are never overwritten automatically.

`priority:p0` 表示阻塞已约定的发布范围，`priority:p1` 表示下一步已排期，`priority:p2` 表示已接受但未排期。Issue 自动分类可根据证据补充初始优先级，维护者保留最终决定权；已有优先级不自动替换，新报告不默认视为已接受或已排期。

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

## Model-assisted issue labels / Issue 自动领域与优先级

The `Issue labels` workflow classifies open issues on `opened`, `edited` and `reopened`, using the same model configuration and repository-managed credentials as PR labeling. It sends only the bounded title (1000 characters), body (12000 characters), existing labels and allowed catalog. Issue text is untrusted evidence, never instructions; do not include credentials in issues. Only existing `area:*` and `priority:p0/p1/p2` labels can be added, at the configured confidence threshold (currently 0.8). At most one priority is selected, and an existing priority is preserved. Missing acceptance, scheduling or release-blocking evidence leaves priority unset; urgency alone is insufficient.

`Issue labels` 工作流在 Issue 新建、编辑或重开时分类，与 PR 共用模型配置及仓库管理的凭据。仅发送限长标题（1000字符）、正文（12000字符）、现有标签及允许的目录；Issue 内容只作不可信证据，不作指令，不应包含凭据。仅按配置的置信度阈值（当前为0.8）添加仓库已有的 `area:*` 和 `priority:p0/p1/p2`，最多一个优先级，保留人工设置。缺少接受、排期或发布阻塞证据时不设置优先级，仅声称紧急不足以定级。

Each run makes at most one model request (60 seconds, 1500 output tokens), without automatic retries. Missing credentials, invalid output and provider failures use conservative bilingual keyword rules for areas only; they do not assign a fallback priority. No labels are created or removed, and no type/process labels or issue assignees are changed. Manual label changes do not trigger classification. Before adding labels, the workflow rechecks title, body, state, update time and labels; changed or closed issues skip stale results. API write failures fail the job. Raw responses, issue text and provider errors are not logged. The workflow runs trusted default-branch code and becomes active after merge; existing issues require an edit or reopening and are not bulk relabeled.

每次运行最多一次模型请求（60秒、1500输出token），不自动重试。缺少凭据、无效响应或服务失败时只按保守中英关键词补领域，不兜底猜测优先级。不创建或删除标签，不修改类型、流程标签或负责人；手动标签变动不触发分类。写入前复查标题、正文、状态、更新时间和标签，内容变化或关闭时跳过过期结果；写入API失败使任务失败。不记录原始响应、Issue正文或服务错误详情。工作流只运行可信默认分支代码，合入后生效；已有Issue需编辑或重开，不批量追溯打标。

Validate with `node --test tests/issueLabels.test.ts tests/autoLabels.test.ts tests/reviewerRouting.test.ts`, `npm run check:i18n` and `npm run build`. Tests use model/API doubles and do not establish live model-service availability or real repository mutation behavior.

使用上述测试、双语检查及构建命令验证；测试使用模型/API替身，不代表已验证真实模型服务或真实仓库写入。

## Model-assisted PR labels / 大模型自动标签

The reviewer workflow classifies open, non-draft PRs on opened, synchronize and ready-for-review events before requesting reviewers. Title, body, filenames and bounded patches are sent to the configured model service; familiar sensitive-file patterns omit patches, but this is not a guarantee of secret detection. Do not include credentials in PRs.

审查工作流在PR创建、新提交和转为可审查时，先分类再邀请审查人，跳过草稿。标题、正文、文件名和限量diff会发送给配置的模型服务；常见敏感文件名不发送patch，但不保证自动识别所有秘密，PR中不得包含凭据。

Only existing `type:*`, `area:*`, `modality:*` and `provider:*` labels from the allowed catalog may be added. The classifier cannot set priority, ready or process-status labels, create labels, remove manual labels or replace an existing type. Invalid responses, missing credentials and provider failures use conservative path rules; unmatched changes retain normal fallback reviewer routing. New commits may add labels but do not remove earlier labels or reviewer requests. Manual label changes do not call the model or immediately re-add removed labels.

只添加白名单内已存在的类型、领域、媒体和服务商标签；不设置优先级、ready及流程状态，不创建标签、不删除人工标签、不替换已有type。响应无效、未配置Secret或服务失败时使用保守路径规则，仍无匹配时沿用默认审查人。新提交可追加标签，不撤销旧标签或邀请；人工标签变化不调用模型，也不会立即补回被移除标签。

One bounded model request (60 seconds, 1500 output tokens) is made per eligible run, with no automatic inference retry or cross-run cache. Repeated eligible events can incur additional API usage. File context is limited to 200 files and 32000 patch characters; partial context may reduce classification accuracy. Before mutation, a changed head SHA, label set, draft or closed state causes the stale result to be skipped. The privileged workflow executes only trusted base-commit scripts, never PR-head code. Model errors and raw responses are not logged. Additions and fallback mode appear in Actions summary. Validate with `node --test tests/autoLabels.test.ts tests/reviewerRouting.test.ts` and `npm run build`; mocked tests do not establish live API availability. The workflow becomes active after merging into main.

每次符合条件的运行最多一次模型请求（60秒、1500输出token），无自动推理重试或跨运行缓存；重复事件可能产生额外费用。最多提供200个文件及32000字符patch，上下文截断可能影响准确性。写入前复查head SHA、标签和PR状态，变化时跳过过期结果。具有写权限的工作流只运行可信base提交脚本，不执行PR分支代码；不记录模型错误正文或原始响应，Actions摘要显示添加标签和兜底方式。运行上述测试及完整构建；模拟测试不代表真实API可用。合入main后生效。
