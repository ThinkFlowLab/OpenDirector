# Generation impact: integration and validation

This records the dependency/reuse foundation for [#355](https://github.com/ThinkFlowLab/OpenDirector/issues/355). User-facing instructions and state meanings are available in both languages in the [CLI guide](../guides/cli.md). It does not establish completion of the full long-video workflow.

## Upstream boundary, checked 2026-11-23

- The isolated implementation starts at upstream `main` `52102ed03d74d08f52face27113fc9d44e283216`. No commits from the local issue-87 branch were carried in.
- Before updating [PR #480](https://github.com/ThinkFlowLab/OpenDirector/pull/480), the branch integrates upstream `main` `8258d4b016496d81a7c824e4cdfa42f3c840d5eb`. This includes [#479](https://github.com/ThinkFlowLab/OpenDirector/pull/479)'s published node workflow and `control` references; the impact contract now accepts that role. Those node operations do not supply the separate #212 workbench service/schema described below.
- The final synchronization also integrates `main` `63279266d7587761399647c61c53f104c76f66f5`, which advanced during validation. The query union retains both upstream `job.status` and this PR's `generation.impact`; both documentation index entries and both error-code sets are retained.
- [#342](https://github.com/ThinkFlowLab/OpenDirector/pull/342) was open at `f9993a1fb9db103ab028103859d26bdf93f4935d`. Its public patch provides H3 compilation, storyboard audit/QC and shot revision, not an adopted-input impact/reuse query. This change reuses existing execution snapshots, input resolution, asset verification and query dispatch.
- [#212's progress report](https://github.com/ThinkFlowLab/OpenDirector/issues/212#issuecomment-6821432061) describes a separate workbench service and editor document. The public branch/PR searches and the [interface request](https://github.com/ThinkFlowLab/OpenDirector/issues/355#issuecomment-7116407885) did not provide a runnable workbench branch or schema. No reply was present on recheck. Overlap with that unpublished implementation remains unconfirmed.
- Client and bilingual display strings are ready; visible workbench integration and a browser language-switch acceptance remain pending #212. No second workbench or speculative workbench document adapter was added.

客户端与双语词条已就绪，工作台可见接入待 #212 提供公共代码及真实契约；本记录不宣称完整 #355、真实 H3 生成质量或续写缓存恢复已验收。

## Shared integration contract

Use `generation.impact` through `POST /api/creation/projects/{projectId}/queries`, the existing Agent query tool, or `opendirector --project PROJECT_UUID query generation.impact --file impact-query.json`. The HTTP request uses the existing local-API request-header protection. No editing session is required.

- Query and report definitions: [commands.py](../../packages/core/src/opendirector/domain/creation/commands.py), [impact.py](../../packages/core/src/opendirector/domain/creation/impact.py), [generated TypeScript](../../src/contracts/generated.ts).
- Frontend: `CreationClient.generationImpact(rootSpecIds, { signal, maxNodes })` in [creationClient.ts](../../src/backend/creationClient.ts). The options are optional. It performs a read without installing the response as a project snapshot or entering the mutation queue.
- Display: pass stable states/reasons to `generationImpactText(code, t)` in [generationImpactText.ts](../../src/backend/generationImpactText.ts). Unknown codes have a translated fallback; no provider payload is rendered.
- Show both `inputState` and `reuseState`, the reasons and original `baselineJobId`/`activeJobIds`. Retain `projectVersion`, `eventCursor` and object revisions for context; they do not reserve a future edit. Any workbench action continues through existing commands with current versions, locks and authorization.
- Reports cover all project generation configurations. `relation` is relative to the requested roots; `timelineConsumers` covers only those roots and their downstream configurations. Consumers are discriminated as `clip` with `clipId`, or `text_overlay` with `overlayId`. Fixed asset usage and source associations are review evidence, not automatic replacement instructions. Recoverable failures and unresolved cancellations retain their original `activeJobIds`.

`projectVersion` and `eventCursor` identify one authoritative project snapshot only. The model catalog is read under its own lock, and effective input rules also use independently read capability observations. These reads do not form one atomic project-and-model snapshot: configuration or observation changes during the query can affect the comparison without changing the reported project version. The report describes observed reuse evidence, not reserved inputs. A subsequent generation submission still resolves and validates its actual inputs through the existing acceptance path.

Timeline asset associations include historical results and unadopted candidates when the timeline actually retains those assets. `association` describes how a usage relates to a generation spec, not whether its asset is currently adopted. Reuse comparison continues to use the successful Job behind `currentResultId`; including a candidate's timeline usage does not adopt it or add a live generation dependency.

### Recorded request and response

The [request](fixtures/generation-impact-request.json) and [response](fixtures/generation-impact-response.json) were captured from `test_reopenable_dependency_case_uses_real_commands_and_files` after editing B's prompt. These UUIDs belong to an isolated test project; substitute IDs from your own project to execute a query. The HTTP sample includes the envelope; the CLI parameter file contains just `rootSpecIds` and optional `maxNodes`.

| Test object | Spec ID | Current inputs | Reuse | Relation |
| --- | --- | --- | --- | --- |
| A | `9264a3d1-0870-4c79-af14-35ce50eaf4e9` | equal | reusable | independent |
| B | `56d1b593-545a-4cb9-8903-fbf620101873` | changed | stale | root |
| C | `2997eb24-2271-4595-aebc-f336c55a92fe` | equal | pending_upstream | downstream |
| D | `39390819-baf0-47cc-bc4e-dceb4fbb51b7` | equal | reusable | independent |

A is an upstream dependency of B, but is not downstream of the requested B root. The timeline contains B/C/D; the response lists B/C consumers with their retained assets and source associations. D remains outside the requested downstream scope. The report contains IDs, fingerprints and controlled field paths, not prompts, provider URLs, credentials, local paths or raw adapter data.

## Coverage decisions

Current active `follow_current` references determine propagation. Pinned inputs, overrides, candidates, display changes and historical Job usage do not create spurious live edges. `context_only` inputs do not propagate future upstream changes; the existing shared fingerprint still decides their current equality after actual adoption.

Subject slots retain assets in their editor document. Their `inputConnections` do not establish live generation-follow semantics. The report keeps document/item/asset evidence without inferring upstream specs from identical bytes or old provenance. Any future #212/#354 slot adapter must explicitly define its live binding semantics.

The comparison uses the same frozen inputs as generation acceptance. Known adapter output settings and generated random seeds remain execution facts. Unknown adapter extension fields or missing saved model rules prevent a reuse claim. Current storage has no reconstructable guide/window/direction plan for external workflows; a future persisted field needs explicit comparison coverage. `reusable` means the registered existing output can be reused under the compared inputs, not a remote cache hit or deterministic new generation.

Inputs are bounded to 100 distinct roots, at most 10,000 configurations (default budget 2,000), and 20,000 active references/expanded edges. Timeline consumers and retained Job IDs share a combined evidence limit of 20,000 entries. A limit error returns no partial success, and HTTP and Agent preserve its stable code. Unresolved dependencies and cycles remain explicit uncertainty, including dependent nodes; no execution order or retry command is invented.

HTTP and Agent queries read the generation service's existing capability observations without refreshing them. Repeated queries reuse the safe asset reader's bounded file-signature verification cache; replaced or deleted files are checked again. Project directory resolution remains under the existing storage lock. This does not introduce a new persistent index or claim a measured production throughput improvement.

Direct application callers should pass their owning generation service's `availability` and shared `assets` when constructing `CreationCanvas`. Without an injected capability service, the standalone reader has only local configuration rules, not another process's transient observations.

Impact error copy is maintained in [impact_messages.py](../../packages/core/src/opendirector/domain/creation/impact_messages.py). Application guards reference the catalog while retaining their existing error codes. The HTTP boundary imports the dedicated `impact_scope_exceeded` translation and continues to use its shared translations for generic `invalid_input` and `missing_object` codes. This keeps unrelated errors' wording and HTTP status handling unchanged.

If a clip is explicitly connected through an ordinary material node containing a related result, the report retains that node's `sourceItemId` alongside its exact asset usage. Its `association` remains `asset`: the source identity records the document connection without creating a live generation dependency. Clips without a source connection retain a null `sourceItemId`.

## Reproducible validation

Run with Python 3.12 and the Node version in `.nvmrc`, using the [validation guide](validation.md) for setup:

```bash
PYTHONPATH=packages/core/src:apps/api/src:tests .venv/bin/python -m pytest tests/test_generation_impact.py tests/test_generation_impact_queries.py -q
node --test tests/generationImpact.test.ts tests/creationClient.test.ts
.venv/bin/python scripts/generate_contracts.py --check
PYTHONPATH=packages/core/src:apps/api/src .venv/bin/lint-imports
npm run check:i18n
npm run build
```

The Python scenario uses real small PNG files, real command acceptance, immutable Job inputs, candidate generation, result adoption, pinning, timeline creation and a fresh project service after reopen. Only model execution is doubled. It verifies query equality across HTTP/Agent/CLI, file and project immutability, one project/catalog read, unavailable output files, foreign-project roots, limits, cycles and a 1,200-node graph. Frontend tests switch the active locale through English and Chinese for all declared report codes and verify typed read behavior while a newer project snapshot arrives.

No live GPU/commercial provider was called. The workbench UI, native visual Harness matrix, browser export and remote continuation caches are separate acceptance scopes; they are not proven by these fixtures.

### Recorded final checks, 2026-11-23

Code under test: `b00b780e9a6260b2169ec27206c3985519e4740d`, on macOS with Python 3.12.10, pytest 9.2.0 and Node 24.22.1. The full run started while that commit finalized, so its profile header records parent `81b9643f`. The reviewed staged diff and the final commit delta have the same SHA-256, `569705ca00960a4fb8c82fb5b823a723d2cc2db4f658ca7b30aa1f1b45fcaa6d`; source files did not change during this run.

| Check | Observed result |
| --- | --- |
| Complete CPU suite with `OPENDIRECTOR_REAL_CLI=1` | 2,960 passed, 111 skipped, 1 dependency deprecation warning; 497.79 seconds |
| Complete layer inventory audit | 3,071 collected, 152/152 required representatives passed, 18 capabilities |
| Impact domain and query cases within that run | 61 passed |
| Actual bundled OpenCode binary with a test model gateway, within that run | 7 passed, 2 Windows-specific cases skipped |
| Complete frontend suite | 962 passed |
| Locale check | 3,352 keys, 0 problems |
| Type checking and production build | Passed; existing large-chunk advisory remains |
| Contract generation, import boundaries and branch static hooks | Passed; 4 import contracts kept |
| Browser locale and manifest inventories | Passed; these checks do not execute browser journeys |

The 111 skips cover unavailable/opt-in native Harness executions and Windows-specific behavior on macOS. The first full run, before review fixes, had one failure: `test_rejects_removed_runtime_and_invalid_selection_before_acceptance` returned 503 during the default runtime check instead of 409. Its isolated repeat passed, and the final complete run passed it in 7.94 seconds. Runtime code was not changed to hide this observation. An intermediate run was interrupted to finish a generated TypeScript input-type correction and is not counted as successful validation.

To repeat the full execution and its inventory check after environment setup:

```bash
OPENDIRECTOR_REAL_CLI=1 PYTHONPATH=packages/core/src:apps/api/src:tests .venv/bin/python -m pytest tests -q -ra -m cpu --ci-profile=test-results/impact-python.json
.venv/bin/python scripts/ci/check_test_layers.py --profile test-results/impact-python.json --require-executed
npm test
```

One independent review identified seven important gaps: shared capability observations, text overlay consumers, recoverable Job identities, the browser node budget, structured Agent errors, a retained-evidence budget, and safe verification-cache reuse. Each was covered by a failing regression before its correction; the final suite above includes the corrected cases. Review and the first full test run ran concurrently; the complete suite was rerun after fixes. No second review was used as a substitute for regression tests.

### Material source identity follow-up, 2026-11-23

The material-node regression initially failed because `sourceItemId` was null; the generation-node case passed. The correction retains the existing connected source identity independently of whether that source follows a generation spec. The regression verifies the retained B1 asset after B2 adoption, both source roles, a clip without a connection, the unchanged A → B → C dependency graph and an unchanged project snapshot.

After this correction, `tests/test_generation_impact.py`, `tests/test_generation_impact_queries.py` and `tests/test_creation_contracts.py` passed together: 141 cases, with the same dependency deprecation warning. The frontend impact/client tests passed 34 cases; generated contracts and all four import boundaries passed. These focused checks cover the follow-up; the complete CPU/frontend counts above belong to the earlier recorded revision.

### Contract and message review follow-up, 2026-11-23

The follow-up to `79e25cc4` clarifies independent project/model/capability reads and the inclusion of actual historical/candidate timeline usages in contract descriptions and bilingual CLI guidance. Schema changes are descriptions only. It also moves impact error copy into a catalog while preserving stable codes, generic boundary translations and status handling. Graph validation and the deferred workbench integration are unchanged.

The candidate-usage regression and expanded missing-object language assertions passed before the message extraction. After the changes, the impact, shared-query, creation-contract and localization modules passed together: 150 cases, with the existing dependency deprecation warning. Frontend impact/client tests passed 34 cases. Contract generation, all four import boundaries, i18n (3,352 keys, zero problems), type checking and the production build passed; the existing chunk-size advisory remains. These focused checks cover this follow-up and do not replace the earlier recorded full-suite evidence.

### Upstream integration and complete review validation, 2026-11-24

The tested tree combines review follow-up `65082d7f` with upstream `main` `8258d4b0`. Upstream's published structure-control input adds the `control` reference role. Its impact-query regression first failed with a contract validation error, then passed after the report contract accepted that role and the generated contracts were refreshed. The regression checks an effective material input's source identity and asset identity without inferring a generation source. It does not qualify remote control-result caches or relax conservative handling of unknown adapter fields.

The complete checks below ran against the merged implementation before its merge commit, so the CPU profile records first parent `65082d7f`. Source files stayed unchanged throughout the final full run; only this evidence record was completed afterward. Environment: macOS, Python 3.12.10, pytest 9.2.0 and Node 24.22.1.

| Check | Observed result |
| --- | --- |
| Complete CPU suite with `OPENDIRECTOR_REAL_CLI=1` | 2,970 passed, 111 skipped, 1 dependency deprecation warning; 555.76 seconds |
| Complete layer inventory audit with execution required | 3,081 collected, 152/152 required representatives passed, 18 capabilities |
| Complete frontend suite | 973 passed; 18.49 seconds |
| Locale check | 3,367 keys, 0 problems |
| Type checking and production build | Passed; existing large-chunk advisory remains |
| Contract generation and import boundaries | Passed; 4 import contracts kept |

The first complete run of this merged tree had one setup error: the worker for `test_real_opencode_native_visual_input[image-model]` received HTTP 503 before its model-input assertions, leaving 2,969 passed and 111 skipped. Its isolated repeat passed in 15.83 seconds, and the final complete run above passed. The available failure output does not establish the cause of the 503. Runtime code, timeout limits and assertions were not changed to hide it. The 111 skips cover unavailable/opt-in native Harness executions and Windows-specific behavior on macOS; no live GPU/provider or new browser workbench acceptance is claimed.

The final CPU execution profile is `test-results/impact-review-python-final.json`; audit it with `scripts/ci/check_test_layers.py --profile test-results/impact-review-python-final.json --require-executed`. Logs and profiles are local ignored artifacts, not prerequisites for using the shared query.

### Final upstream conflict resolution, 2026-11-24

After publishing `35e2fd9c`, the remote check found that `main` had advanced to `63279266`. Integrating it required combining the documentation index and query/error-code unions, then regenerating the shared contracts. One hundred other staged paths exactly matched upstream blobs. The affected query wiring retains shared capability and asset services through HTTP, Agent and the frontend client.

The merged tree passed 351 Python regressions across impact queries, contracts, localization, Agent gateway/metadata, CLI, HTTP creation, canvas/assets/history services and rule facts (39.09 seconds, one dependency deprecation warning). The complete frontend suite passed 981 cases (13.65 seconds). Contract generation, all four import boundaries, i18n (3,377 keys, zero problems), type checking and the production build passed; the existing chunk-size advisory remains.

These focused Python checks validate the final conflict resolution. The 2,970-pass complete CPU run above belongs to `35e2fd9c` before this last upstream integration; it is not a full-suite result for the final merge. No additional workbench browser acceptance is claimed.

```bash
PYTHONPATH=packages/core/src:apps/api/src:tests .venv/bin/python -m pytest tests/test_generation_impact.py tests/test_generation_impact_queries.py tests/test_creation_contracts.py tests/test_localization.py tests/test_agent_gateway.py tests/test_cli.py tests/test_creation_api.py tests/test_creation_canvas_service.py tests/test_creation_assets.py tests/test_creation_history_service.py tests/test_agent_metadata.py tests/test_rule_facts.py -q
npm test
```
