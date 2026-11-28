# OpenDirector canvas workflow

For `generation-spec update --file`, put the full saved spec under `payload.spec` and provide its current version in `expectedVersions`. Use a new operation ID after correcting an invalid payload.

If a native agent login shell resolves a different OpenDirector CLI, use the turn-local `./.opendirector-bin/opendirector` when present (on Windows, `.opendirector-bin/opendirector.cmd`). This launcher uses the same Python environment as the serving OpenDirector instance.

## 1. Select the project and model

Use the current project and reuse its existing source video and portrait nodes. Read `opendirector project show` and `opendirector model list --kind video`. Use `opendirector model show <configuration-id>` for one configuration and CLI `--help-field payload` for command schemas. Before building a segmented group, verify `group publish-run` and `group start-run` (plus `group step-run`, `group regenerate-run-step`, `group adopt-run-candidate`, `group reconcile-run` when needed) exist in `opendirector capabilities`. If publication or execution commands are missing, report the version mismatch and stop at the plan.

Before preparing clips, test whether the Agent can inspect a portrait. For a project asset, run `opendirector query asset.preview --object-id <portrait-asset-id>` and open `preview.path` with the image-reading tool. If the Agent cannot inspect it, ask for an image-capable Agent model and pause.

Check `inputRules` for reference mode, input limits, duration, resolution and audio. If switching to a compatible model requires approval, ask before editing the canvas.

Published segmented Runs require `videoMode: reference` on a `fasth3-omni` deployment (`inputRules.profile: fasth3-omni`). Any `continuation` step also requires `inputRules.videoCapabilities.timelineGuides: true`. Other profiles (including `vllm-omni-h3`) are rejected by `group.publishRun`. Keep the group in draft if a compatible FastH3 deployment is unavailable.

Check model availability once before planning. If the declaration is `unknown` because the protocol is unavailable, use the compatible configuration's `inputRules` and continue through the normal group preflight. Report a concrete rejection from preflight or submission. Use [a guided job](#source-video-continuation-with-timeline-guides) to verify guide delivery. When reproducing a take, check the deployment, character-swap adapter settings, resolution and seed.

## 2. Build the canvas

Follow the [segment plan](video-segment.md). If an original is only in the project library, get its asset ID and revision from `project show` and download the original bytes to a new path with the matching extension:

```sh
opendirector asset download --id "$SOURCE_ASSET_ID" --revision "$SOURCE_ASSET_REVISION" --output source.mp4 &&
ffprobe -v error -show_streams -of json source.mp4
```

The command also downloads portraits and needs no editing lease. In Agent Shell, keep downloads and inspection files in the execution directory. In a terminal, pass `--project` before `asset` when selecting a project.

In Agent Shell, register a prepared clip or an [eligible portrait derivative](prompt-writing.md#resolve-the-replacement-scope) with `opendirector asset import <file> --kind <video-or-image>`. Add `--source-item-id` and `--source-asset-id` for a derivative of an existing canvas node. Show the registered asset as a material node and bind it to the planned video or portrait slot. Each segment's prepared source clip is `<Video 1>`.

Before importing a source clip, run `ffprobe -v error -show_streams -of json <clip>` to check [embedded source audio](video-segment.md#keep-source-audio-in-reference-clips). Verify sync near cuts and speech, and bind the checked clip version as `<Video 1>`. Add a separate audio reference only for a different sound source. Keep `generateAudio: true` (the FastH3 adapter rejects `generateAudio: false`); the timeline controls delivery audio.

Use `canvas create-generation --file` for pinned references, explicit output settings and H3 guidance. For a pinned reference to a canvas item, set `source` to the full `AssetRef` object and `sourceVersion` to the canvas item version. Edit an existing spec with `generation-spec update`, passing the full spec and its current revision.

Build the draft group with these required invariants:

- **Group & specs.** Put the generation nodes and timeline in an unlocked, visible top-level group. Give each segment its own generation spec with `videoMode: reference`, an explicit integer `parameters.seed` (`group.publishRun` always requires a seed; omit unsupported sampling fields), and one pinned source video.
- **References & H3 guides.** Pin every appearance reference and preserve its order. Clear `materialOverride` and wait for any unfinished jobs on those specs before publishing. Save `parameters.h3Segment: {}` on every anchor, and save `{guideReferenceId, sourceFrames}` on continuations. Read specs back before publication; if video reference count exceeds the limit, verify `h3Segment` and the single pinned source video first.
- **Timeline & delivery audio.** Give each group its own visible timeline (created via `creation.batch` with `editor.create` and `canvas.show`) and an unused `outputItemId`. Set timeline width/height to the model's effective output size for the chosen resolution and aspect ratio, and set timeline FPS to the normalized source FPS. Inspect the schema with `opendirector editor save --help-field payload.document@timeline`. Start with one empty `visual` track, no overlays, and one `audio` track containing a single clip from timeline zero (`inPoint: 0`, `outPoint` at the earlier of the natural soundtrack end and `frameCount / fps`, within one frame of picture end, `speed: 1`, `volume: 1`, unmuted) bound to the exact delivery soundtrack asset version. Set the editor `inputConnections` entry's `sourceId` to the audio canvas node ID and `slotId` to the audio clip ID with the same asset version. Probe the unpadded audio duration before setting `outPoint`.

### Verify saved connections

Read `project show` after building the canvas. Each clip cut from a project video node needs a visible material node and an asset whose `provenance.sourceItemId` identifies the original. Each planned portrait, source clip or guide link needs an active reference to the intended generation spec (`source.id` for `follow_current`, `sourceVersion.id` for `pinned`). Check the resolved guide when the donor result is ready.

If links appear missing, check saved references and visible endpoints first, then the **Show connections** control. If the run stops before publication, report the last saved step and the missing nodes or references.

### Publish and verify the plan

Use the task name as the canvas group title. Use "group" for the canvas object and "execution" for each attempt.

Use `group.publishRun` to publish the group and create its visible plan node atomically. Prepare `run.json` with `payload.groupId`, `payload.plan` and `payload.assembly`, plus `planLocale` (`en-US` or `zh-CN`) matching the user's language or requested plan language. Put the ASCII segmentation diagram in a fenced code block at the top of `planNotes`, followed by per-segment assigned tracks, actual first input frame and identifiable tracks, continuation guide source frames and identifiable tracks, and the inspected shot rationale. See [Case03](examples/case03.md) for a historical baseline example.

Both pre-publication checks must pass before publishing:

- **Frame plan & window geometry.** Verify consecutive real source frames (no padding, freezes or loops), synchronized audio where present, `17k+5` alignment with `k >= 6` (minimum 107 frames), and the 6-second cap (at 24 FPS: 144 frames max, largest aligned count 141). Decode and count frames on every pinned input video; each decoded count must match its requested generation count. Inspect both sides of every generation split and each actual first input frame (including reversed inputs) so no visible assigned face is occluded. Run `validate_frame_plan.py` with `--enforce-window-limit --inspection shot-inspection.json --normalized-source "$NORMALIZED_SOURCE"`.
- **Person tracks & prompts.** Follow each source person across cuts, position changes and occlusions using confirming frames. Verify that every segment's title, saved prompt mapping, `shotSubjects` / `[Shot N]` rows (including unassigned shots), `foregroundOccluder` evidence frame, and ordered pinned portraits agree. If a clip or direction changed, re-inspect and rebuild. Run the following command first to generate prompts from the inspection. Once clips are cut, add `--check-clips`. Use `trim`/`atrim` on the same real source interval and preserve any natural audio end. Pad, freeze, and loop filters are prohibited for model inputs and the delivery soundtrack. After importing and binding the clips, add `--project-snapshot saved-project.json --soundtrack "$SOUNDTRACK"` to verify the exact clip, saved prompt, ordered portrait versions and the guide link before publishing. Save `project show` directly to that file. Resolve every preflight error before proceeding.

```sh
opendirector skill-script character-replacement/scripts/check_replacement.py frame-plan.json shot-inspection.json prompt-options.json \
  --normalized-source "$NORMALIZED_SOURCE" --prompt-inputs replacement-prompt-inputs.json > prompts.json
```

Build `run.json` to match the backend schema:

- `plan.source` is the exact `AssetRef` of the normalized full source; `fps` and `frameCount` are its decoded values. `plan.entries` uses half-open `[sourceStart, sourceEnd)` intervals covering `[0, frameCount)` once in source order (`kind: source` for passthrough, `kind: generated` for generated ranges).
- Each generated entry specifies `itemId`, continuous `shot`, and `step` (`kind: anchor` once per shot; `kind: continuation` with `upstreamItemId` in the same shot and two distinct ordered raw `sourceFrames`). A generation node reused across multiple delivery intervals repeats the same `shot` and `step` and adds one trim per interval in delivery order in `assembly.clips`. Omit legacy fields `requireTimelineGuides` and `guideExemptItemId`.
- `assembly` supplies `timelineItemId`, a fresh `outputItemId`, and `clips` for the generated entries in delivery order, where each `outFrame - inFrame` equals its source range length. Set `reverse: true` and `frameLimit` when reversing, using post-reversal keep coordinates.

Set `replacementPromptInputs` on every `kind: generated` entry in `plan.entries` to the structured segment object used to render that node, including `shotSubjects`. Repeat the same object when an entry reuses the node. Save the complete rendered prompt as plain text and bind media as separate references. The server rerenders the built-in template at publication, and rejects differences with the segment and first changed line.

```sh
opendirector group publish-run --help-field payload
opendirector group publish-run --file run.json --expected-version "canvas_item:$RUN_ID:$RUN_REVISION"
opendirector canvas text show --id "$PLAN_ITEM_ID"
```

Set `PLAN_ITEM_ID` from the receipt's `planItemId`. Read the plan node and `project show` to confirm the visible plan links to the group and matches `runPlan`, `assembly`, pinned inputs, ordered portraits and guide pairs. Wait for confirmation if the user requested plan review first.

## 3. Start the group and review outputs

Before starting, fill each local `frame-plan.json` segment's `itemId` with the published canvas node ID, save the latest `project show` snapshot, then repeat `check_replacement.py` with `--project-snapshot saved-project.json --run-id "$RUN_ID"`. This rechecks published trims, guide indices and upstream nodes as well as the saved prompts and reference versions. Resolve mismatches before starting.

When authorized to generate, choose the execution mode that matches the user's request:

- **Full automatic run.** Select the published group and click **Run group**, or start via CLI once. The background executor runs segments in dependency order, takes guides from this execution's upstream results, assembles and publishes, even if the canvas or Agent session closes.
- **Single-step / per-segment approval.** When the user wants to inspect and approve each donor before its dependents run, use `group step-run` instead of `group start-run`. Calling `group step-run --group-id "$RUN_ID"` without `--execution-id` starts a new execution and pauses after the first stage; calling it again with `--execution-id "$EXECUTION_ID"` advances one stage at a time.

```sh
opendirector --operation-id "$START_ID" group start-run --group-id "$RUN_ID"
opendirector query run.execution.get --object-id "$EXECUTION_ID"
opendirector query run.groupExecution.get --object-id "$RUN_ID"
```

Use a stable `START_ID` and record `runExecutionId` from the receipt as `EXECUTION_ID`. On timeout or a lost response, query `run.execution.get` (or `run.groupExecution.get` / `run.groupExecutions.list`); replay the same operation ID with identical input only if the start was unconfirmed. Submit segments and assemble published groups only through the group executor.

- **`failed`**: inspect `issue` and read affected `steps[].jobId` with `opendirector job show <job-id>`.
- **`needs_review` or `issue.code: submission_unknown`**: keep the execution and job IDs and check provider acceptance without resubmitting. Once the original job's outcome is confirmed (succeeded, failed, cancelled, expired, or remote task missing), reconcile the execution with:

```sh
opendirector --operation-id "$RECONCILE_ID" group reconcile-run \
  --group-id "$RUN_ID" --execution-id "$EXECUTION_ID"
```

- **Pause / resume / restart**: use the group's pause control or `opendirector group pause-run --group-id "$RUN_ID"` to stop after the in-flight step and wait for `paused`. Resume with `group resume-run --group-id "$RUN_ID"` to keep completed steps, or start a fresh full run with `group restart-run --group-id "$RUN_ID" --execution-id "$EXECUTION_ID"`.

### Review and retry a take

Compare the raw result, its keep range and the matching source interval side-by-side at the same speed. Verify each visible action occurs once in source order (onset, direction, end), identities and replacement scope hold through cuts and occlusions, and unselected people remain intact before, during and after crossings.

Record a review row per inspected shot (source range, raw output range, assigned tracks, result). At cuts, compare the last outgoing and first incoming frames. In tight or partially occluded shots, compare visible in-scope features against the assigned portrait; remaining source identity fails that shot even if earlier shots passed. Check a proposed guide donor at its actual extraction frames and reject it if it shows a missed replacement or wrong shot.

When a defect is found, record the execution ID, job ID, first mismatched source and raw output frames, and expected result. Read the frozen prompt, reference versions, guide frames and source range before changing anything. Choose the smallest retry mechanism that fits the change:

1. **Same inputs, new sample for one segment (`group.regenerateRunStep` + `group.adoptRunCandidate`).** When the published prompts, references, guides and trims are sound and you only want to resample a failing segment without re-running unaffected upstream steps:

```sh
opendirector --operation-id "$REGEN_ID" group regenerate-run-step \
  --group-id "$RUN_ID" --execution-id "$EXECUTION_ID" --item-id "$SEGMENT_ITEM_ID"
```

The executor reuses unaffected upstream steps, generates a new-seed candidate for `SEGMENT_ITEM_ID`, and pauses in `awaiting_selection` with `candidates`. Inspect the candidate; call `group regenerate-run-step` again for another sample, or adopt the winning candidate to continue dependent steps and assembly:

```sh
opendirector --operation-id "$ADOPT_ID" group adopt-run-candidate \
  --group-id "$RUN_ID" --execution-id "$EXECUTION_ID" --job-id "$CANDIDATE_JOB_ID"
```

Inspect the decoded first and last retained frames and both sides of every clip join and planned cut (including cuts inside generated clips). Record remaining offsets or failed intervals. Hand off the verified output node, its measured frame count, FPS and delivery audio.
