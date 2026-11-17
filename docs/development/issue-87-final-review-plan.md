# PR #193 complete review and repair plan

**交付状态 / Delivery status（2026-11-08）：** 本计划的已交付步骤由后续整合与收尾记录关账，
最终源码为 `97edaf4e`，main 基线 `c54d78eb`。`733001a2` 的桌面/1080p/性能及 `1799464f` 的补验证据
保留原版本；最终范围、命令、失败处理、跳过项和剩余限制见[验收记录](issue-87-validation.md)
及[收尾计划](issue-87-post-windows-plan.md)。原建议命令和提交标题保留作实施约定，
复选框表示对应交付能力已完成，不表示在 Windows 逐字执行过 POSIX 示例命令。
Historical planning and evidence are preserved; this completion notice does not relabel prior runs as new tests.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans task by task. The user authorized review, planning and implementation in this session; continue without a separate approval stop.

**Goal:** Repair every confirmed issue from the complete PR review and publish a verifiable follow-up to the existing Draft PR.

**Architecture:** Keep shared timeline commands and persisted state unchanged. Fix native resource ownership at its commit boundary, preserve uncertain POSIX outputs, reuse validated session directories, and make browser tests follow the same business semantics as production.

**Tech Stack:** Python 3.11+, TypeScript/React, Node tests, pytest, real isolated Chrome, Windows WinAPI regression fixtures.

**Spec:** [Issue #87](https://github.com/ThinkFlowLab/OpenDirector/issues/87), [feature plan](issue-87-editable-timeline-text-plan.md), repository guidance and [validation record](issue-87-validation.md). Reviewed all 163 changed files at `733001a2811399e668ccf46256034864ae8a9ed6` against `2f35c78ee3b4d7ba389bf62686762b5c849c0062`, including generated-contract verification and relevant unchanged callers. Backend review found no additional confirmed defect.

## Global constraints

- Preserve published commits, unrelated files and platform protections; use the existing isolated review worktree, no force push or merge.
- Keep UI/Agent commands, locks, object versions, immutable publications and bilingual messages intact. No new model calls, subtitle formats or rendering engine.
- Trust host session identity and native write receipts; treat workspace contents, aliases, concurrent ACL changes and concurrent output replacement as mutable inputs.
- Never infer ownership of an ACL entry or filename from an abandoned attempt. Native Windows execution remains distinct from deterministic tests run on macOS.
- The POSIX output API cannot atomically unlink an open inode by name. Preserve possible partial outputs on failure instead of check-then-unlink; retain exclusive creation so retry cannot overwrite existing content. This deliberately relaxes failure cleanup, not file access or error reporting.
- Retain past Windows/wheel evidence with its original revision. New Windows-only tests require a fresh native run before that evidence covers this follow-up.

## Review focus

- Successful cleanup followed by a retryable conflict must remove the lease's delta only once (Task 1).
- A reused Claude skill alias may be refreshed, but a real directory at that name must survive refusal (Task 2).
- PATH-only Python and invalid explicit overrides must behave predictably without a repository venv (Task 3).
- Renaming/replacing an output before a copy/flush failure must not cause another file to be deleted; original errors must remain observable (Task 4).
- Drag/trim previews must move before release, cancel cleanly and commit one undoable edit; display hiding must preserve active references and adoption (Task 5).

## Tasks

### Task 1: Consume ACL cleanup deltas at successful native writes

**Files:** `agent/owner_rights.py`, `tests/test_owner_rights_journal.py`, `tests/test_owner_rights_lifecycle.py` (production paths are under `packages/core/src/opendirector/`).
**Interface:** `_Projection.close()` continues to call `edit(..., on_write=...)`; `_Windows.set_acl` remains the authoritative write acknowledgment.

- [x] Add failing deterministic cleanup cases for pre-write and post-write conflicts, including a successful setter followed by a caller exception. The external identical deny and unrelated deny survive; pending cleanup is consumed only on successful writes.
- [x] Add a real WinAPI cleanup/oplock regression using the existing lifecycle fixture.
- [x] Clear the pending removal delta in the successful setter callback; keep retries, validation and handle cleanup.
- [x] Run `pytest tests/test_owner_rights_journal.py tests/test_owner_rights.py tests/test_owner_rights_lifecycle.py tests/test_owner_rights_resume.py -q`. Expect all executable cases to pass; record Windows skips explicitly.

### Task 2: Restore Claude continuation with real command preparation

**Files:** `agent/native.py`, `tests/test_native_runtime.py`, existing `agent/directory_links.py` helpers.
**Interface:** `command('claude', ...)` refreshes only an existing alias; it never deletes a real directory or file.

- [x] Add a two-turn regression using real `NativeRuntime.stream`, real command construction, a real fixture subprocess and the persisted session record. Expect the current second turn to fail with `FileExistsError`.
- [x] Reuse alias-only unlink before recreating the skills link; add a refusal check preserving a real directory sentinel.
- [x] Run `pytest tests/test_native_runtime.py tests/test_native_sessions.py tests/test_directory_links.py tests/test_skill_snapshot.py -q`; both turns share the workspace/session and refresh skills.

### Task 3: Discover Python in standard CI environments

**Files:** `tests/browser/host.mjs`, `tests/browserHost.test.ts`, validation guide.
**Interface:** `pythonExecutable(env)` uses explicit `PYTHON`, then project `.venv`, then PATH `python3`/`python`; explicit invalid overrides fail. Preserve venv symlink spelling and the Windows packaged-Python guard.

- [x] Add a failing subprocess regression from a fresh directory with no `.venv` and no `PYTHON`, using an actual PATH interpreter. Check actual execution and prefix; cover explicit override and venv preference.
- [x] Implement fallback discovery without shell execution or altering process ownership.
- [x] Run `node --test tests/browserHost.test.ts`, including process-tree cleanup and unrelated sentinel preservation.

### Task 4: Preserve uncertain POSIX outputs on failure

**Files:** `infrastructure/execution_files.py`, `tests/test_execution_files.py`, `tests/test_posix_execution_files.py`, bilingual CLI/user documentation and lessons.
**Interface:** `execution_file(..., create=True)` still creates exclusively, validates ancestry and closes descriptors; failures propagate without deleting the public pathname on POSIX. Windows retains exact-handle cleanup.

- [x] Add a real POSIX regression that renames the owned output, writes an unrelated replacement, then fails. Assert replacement and moved bytes survive, original exception propagates, and descriptors close.
- [x] Remove pathname rollback; update existing failure checks to the explicit platform contract and verify retries cannot overwrite retained bytes. Cover missing output and flush/dup/fdopen failures.
- [x] Run `pytest tests/test_execution_files.py tests/test_posix_execution_files.py tests/test_timeline_packages.py -q`; document checking the failed output and choosing a fresh output path for retry.

### Task 5: Repair live text gestures and browser contract checks

**Files:** `src/canvas/TimelineEditor.tsx`, `tests/browser/timeline_text_editing.mjs`, `scripts/verify_creation_browser.mjs`, `tests/browser/hidden_references.mjs`.
**Interface:** `TimelineTextLane.timeline` receives `dragPreview ?? timeline`; gesture origin stays captured in `useTextDrag`. Hiding affects presentation only; explicit reference removal still changes business input.

- [x] Add real browser assertions while move/start-trim/end-trim pointers remain down; check cancellation and one undo step. Observe failure before changing the lane prop.
- [x] Pass transient timeline to the lane, retaining committed draft semantics.
- [x] Update the stale adoption/hidden-chip assertions, dismiss the welcome overlay in the hidden-reference fixture, and retain frozen-input, explicit-removal, restore and reopen checks.
- [x] Run the real editing, closure and hidden-reference suites; then the complete 19-workflow browser gate and representative text render/archive/coverage suites.

### Task 6: Final verification, evidence and publication

**Files:** validation record, lessons, bilingual Windows follow-up, prior plan status and PR description.
**Interface:** Report exact source revision and platform per test; old Windows results do not certify new ACL tests.

- [x] Run complete Python and Node suites, generated contracts, four import-boundary checks, i18n, browser locale/manifest and production build.
- [x] Obtain one independent final review of the repair diff plus full-review coverage; fix confirmed important findings with failing regressions and rerun affected checks.
- [x] Update evidence and a narrow Windows follow-up for this repair range; remove obsolete pending work from the PR description without claiming new native runs.
- [x] Commit the reviewed changes, synchronize the configured upstream while preserving merge history, and push normally to the existing Draft PR. Inspect new CI results and resolve failures attributable to the changes.

Task commits may be consolidated after verification so the review/fix/tests/evidence are delivered together. No test or platform acceptance is complete merely because it is listed here.
