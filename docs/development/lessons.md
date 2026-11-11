# Development lessons

This record highlights risks identified from actual fixes. It does not imply that the same defects remain in the current code. Consult relevant lessons before a change and verify the current implementation and tests; the [validation guide](validation.md) defines commands and evidence requirements.

When implementing or reviewing a change, trace the affected behavior from its entry point to persisted state and side effects, and inspect related entry points for the same defect when relevant. Apply the checks that fit the change and record verification and remaining gaps as described in the validation guide.

When work exposes a consequential risk or a recurring problem, add a lesson or update an existing one with the trigger, failure, suggested check, and a verifiable issue, PR, or commit. Add evidence when a problem recurs. Move requirements proven durable in practice into the validation guide, and revise or remove outdated lessons. Do not count distinct defects as repetitions of the same problem, or add a lesson for every routine fix.

## Model capabilities and requests can diverge

- **Trigger:** Creating a generation node, configuring model capabilities, or constructing a provider request.
- **Lesson:** Defaults, reference slots, and request parameters can fail at different layers. Commit `f623fedd` corrected node defaults that did not match the adapter; `f9e358cf` filled the last-frame slot for models that support it; `1bafbbd6` corrected an integer duration sent to Ark as a float.
- **Check:** Trace representative input from the relevant UI or Agent entry point through backend validation to the provider request. Check that unsupported input does not create a job. Distinguish protocol mocks from real service evidence.

## Operations across boundaries can lose identity or context

- **Trigger:** Importing a project, referencing assets across conversation turns, or switching projects during a run.
- **Lesson:** Commit `e8c29c9b` fixed provenance and creation-order problems in a canvas archive round trip; `44857448` fixed asset context across turns; `00d8899c` fixed Agent runs stopping when switching projects. These are different defects, but each shows that the current display alone cannot establish state and context.
- **Check:** As relevant to the change, inspect persisted object identities, references, and execution inputs after conversion or recovery. Reopen the project or reconnect to the run when needed, and verify the actual result.
- **Async projection follow-up:** PR #193's structured-editor CI failure prompted a real-browser delayed-read regression. An older background projection could finish after an acknowledged editor save and restore an obsolete CAS basis, making the next save/publication fail. Recheck the editor transaction and captured snapshot at completion before installing either changed or apparently identical content. Keep publication versions fixed, test the actual save/retry/provenance path with a deterministic interleaving, and retain the original CI failure rather than treating a longer timeout or a rerun as its explanation.

## Baseline failures still need tracking

- **Trigger:** A relevant test fails and comparison shows that it also fails on the baseline.
- **Lesson:** Commits `28d61dce` and `0a5630ac` each recorded the same generation test failing on the baseline. That historical record does not establish whether the test still fails today.
- **Check:** Record the versions and results used in the comparison. Link an existing issue or create one when appropriate. Report the check as failed; a baseline failure is not a pass.

## Shared browser lanes are not isolated by a fresh page alone

- **Trigger:** Adding a browser script to the nightly extended, production, or perf lane, or changing model setup, session leases, or preview serving.
- **Lesson:** Nightly runs many scripts against one creation server. The first-run welcome covers the canvas until every model kind exists, so a script that does not dismiss it fails when it is the first click on a fresh server. A script that opens whichever project sorts first can hit a lease still held by an earlier script. Fixture scripts that read `CREATION_WEB_URL` stay on the regular dev server unless the lane overrides it. `vite preview` does not serve `/src` or `/tests` modules.
- **Check:** Dismiss `opendirector.modelSetup.v1` before the first navigation, and open a project the script itself created when the server is already populated. Point assistant-fixture scripts at their own web URL, and keep `/src` or `/tests` imports out of the production lane. `npm run check:browser-manifest` checks the dismissal, the fixture URL, and those imports.

## Native permission plans are not committed permissions

- **Trigger:** Retrying an ACL read/modify/write or rolling back failed initialization.
- **Lesson:** [PR #193](https://github.com/ThinkFlowLab/OpenDirector/pull/193) reproduced an abandoned plan claiming an external writer's identical owner deny. Recording only after the final conflict check has the opposite problem: a successful native write can still need rollback when that check fails.
- **Check:** Record the installed delta at the native setter's success point, before caller-side exceptions or post-write conflict checks. Test no-write retries, an external identical ACE, successful-write conflicts, failed initialization, cancellation and real lease close with both deterministic control flow and actual WinAPI writers. Do not describe a control-flow counterexample as a demonstrated sandbox escape.
- **Follow-up:** The same rule applies to cleanup. In PR #193, a cleanup setter succeeded and a later conflict retried the removal, deleting an external identical deny. Consume the pending removal at the native write acknowledgment and inject conflicts during cleanup itself, not only installation.
- **Windows follow-up:** Native validation also found a guard breaking inside setter preparation before the actual write. Consuming cleanup at that doomed write let a waiting writer replay the old ACL and leave a temporary read grant. Recheck the guard immediately before the native setter, retain successful-write receipts, and verify both no committed write under an already broken guard and preservation of external denies. When adding this check, keep post-write fault injection after the actual native acknowledgment; do not accidentally move that regression before the write.
- **Final-window follow-up:** Native PR #193 regressions also broke the guard after the final pre-write check returned and after the final post-write check returned. A check is not an atomic write/cleanup guarantee. Retain the one-time native removal receipt, verify its ACE multiplicities under a fresh guard after a conflict, and report unconfirmed cleanup rather than spending the delta again. At release, distinguish a real oplock-break completion from the host's own cancellation and preserve an existing body error. This contract cannot prevent a principal with independent WRITE_DAC from changing permissions after the guard has been released; do not claim permanent ACL immutability.
- **Installation ownership follow-up:** A deterministic PR #193 probe also replayed the pre-install descriptor plus an external identical deny. Retaining both successful installation receipts across the retry let cleanup remove the external rule. ACE counts cannot establish provenance: an equal-count replacement is also possible. If the installation's guard cannot finish successfully after a native acknowledgment, stop initialization and report unconfirmed ownership without retrying or removing that handle's uncertain ACEs. A setter wrapper error with a successfully checked and released guard remains an ordinary rollback case. Cover pre-write retry, both replay shapes, additive writers, partial preparation, setter errors and release failures; distinguish portable control flow from actual Windows scheduling.

## A process exit and ownership of its descendants are separate facts

- **Trigger:** Adapting browser fixture cleanup or sampled process memory to Windows.
- **Lesson:** [PR #193](https://github.com/ThinkFlowLab/OpenDirector/pull/193) observed a Microsoft Store Python launcher's grandchild surviving private-job termination; the same native test passed with unpackaged Python.org. Separate tests also observed `exit` before inherited stdio closed. A root PID or a stream event alone did not prove tree cleanup.
- **Check:** Create controlled Win32 children suspended in a private job, check actual descendants and an unrelated live sentinel, and reject unsupported packaged Python before launching the application. Distinguish Node's [exit and close events](https://nodejs.org/api/child_process.html#event-close); close only owned pipe endpoints after verified process/job termination. Sample actual kernel working sets for bounded CDP PIDs and report unsupported access as an error, not a fabricated measurement.

## Resuming a native workspace is different from initializing an empty tree

- **Trigger:** A validated native-session record reuses a populated execution directory.
- **Lesson:** [PR #193](https://github.com/ThinkFlowLab/OpenDirector/pull/193) found that fresh-only permission setup rejected the second turn. Rewriting existing skill-directory ACLs also made rollback depend on directories replaced during preparation, and retaining inspection READ_DATA handles blocked PowerShell writers that omit FILE_SHARE_READ.
- **Check:** Select resume mode only from the validated host session record. Retain path, identity, reparse and single-link rejection, ancestor coordination and sandbox checks. Leave every writable object's descriptor unchanged and release inspection-only file handles before execution. Test real two-turn sandbox writes, outside-write denial, skill replacement, cancellation and lease reacquisition; keep fresh initialization's refusal of existing files.
- **Follow-up:** Exercise the real command builder on continuation. PR #193's mocked command builder hid Claude's unconditional recreation of an existing skills alias. Refresh only the alias and preserve ordinary files/directories at that location.

## Exclusive creation does not confer ownership of a later pathname

- **Trigger:** A POSIX output is renamed/replaced during a failed copy or flush.
- **Lesson:** [PR #193](https://github.com/ThinkFlowLab/OpenDirector/pull/193) reproduced failure cleanup deleting a different writer's replacement while retaining the original renamed inode. Pinning the parent and using `O_EXCL` at creation do not make later pathname deletion safe. A stat check followed by unlink still has a race.
- **Check:** Never delete an uncertain output by its public name. The execution-file writer preserves possible partial POSIX outputs, propagates the failure and requires exclusive creation on retry. Test replacement, disappearance, copy/flush failure and descriptor release; distinguish this from Windows' exact-handle cleanup. If atomic publication becomes necessary, define a trusted staging boundary and a publication commit point first.

## Provider result URLs are an independent trust boundary

- **Trigger:** Accepting a cross-origin result URL from a configured model service.
- **Lesson:** [PR #210](https://github.com/ThinkFlowLab/OpenDirector/pull/210) added compatible image CDN downloads without provider credentials, but initially left arbitrary local and private hosts reachable. Credential isolation and bounded responses do not constrain the network destination.
- **Check:** Preserve explicitly configured local service origins; validate all DNS answers for unconfigured hosts, connect to a checked public IP while retaining the original Host and TLS identity, and revalidate every redirect. Cover local metadata addresses, IPv6, mixed DNS answers, redirect loops, and recovery without another model submission.


## An acknowledged editor save invalidates earlier automatic callbacks

- **Trigger:** A workspace timer retains its document while an editor commit installs a newer authoritative baseline.
- **Lesson:** A timer may run after the editor's saving flag clears but before React installs the new document. Comparing that old closure against the new baseline can turn a view-only save into a business rollback, invalidating a previously captured publication version.
- **Check:** Invalidate scheduled automatic callbacks when the editor transaction starts, drain queued saves and explicitly persist the current draft before the edit. Preserve publication CAS checks. Exercise the real due callback at the acknowledgment boundary; isolate projection-test gates by snapshot identity, assert release/restoration and always clean up. Distinguish a forced reproduction from proof of the exact CI schedule.


## An upstream response and a consumer finishing it are separate facts

- **Trigger:** Forwarding streamed model responses through the loopback gateway.
- **Lesson:** [Issue #274](https://github.com/ThinkFlowLab/OpenDirector/issues/274) reproduced bundled OpenCode 1.19.5 / Bun 1.4.4 receiving every byte of a close-delimited response but never completing its body reader. Tools could execute before a 300-second timeout replayed the same model context. Python consumers completed the same response, so Python-only tests missed the integration failure.
- **Check:** Preserve incremental forwarding with explicit HTTP framing. Terminate the body only after successful upstream exhaustion; leave transport failures and cancellation distinguishable from completion. Exercise the actual bundled consumer with a local mock model, asserting request and tool execution counts, continuation with tool results, final text and persisted state. HTTP completion is not model completion or business acceptance.
