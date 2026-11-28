# Video segments

For a hard cut from a group shot into a solo speaking close-up, plan separate generated results at the source cut. Start the solo result from the first identifiable frame of the close-up, retaining the original delivery cut. Extend either model input with real adjacent footage as needed for frame alignment, and trim that context during assembly.

When a reviewed candidate repeatedly loses a verified hard cut, anchor the delivery join at that exact source frame and use separate generated results on either side. Input windows can still overlap on real source footage to meet frame alignment. Two trims of the same generated result do not restore a cut that the model omitted. Record the observed failure as `splitReason`.

## Visual inspection comes first

Probe duration, frame rate and frame count. Use a constant 24 FPS working copy unless the user requests another rate. If conversion is needed, use a frame-rate filter such as FFmpeg `fps=24` at the original playback speed. Keep the original media and soundtrack. Check audio alignment and count decoded video frames with `ffprobe -count_frames`. Use the working copy once its FPS and decoded frames cover the plan. The assembler validates exact duration on its rendered clips. A difference in the input container duration alone needs no re-encoding.

Inspect the full source video and the portraits. If direct playback is unavailable, start with a timestamped contact sheet. For a set of known frame numbers, extract them in one decode pass with FFmpeg’s `select` filter. View consecutive frames at proposed boundaries, cuts, entrances, exits, crossings and occlusions. If you cannot inspect the images, report which part of planning is blocked.

For each candidate cut, inspect the frame immediately before and after it. Record the first frame of the new shot as the cut, including a blurred opening frame. If the face first becomes visible later, preserve the intervening frames from the source. If the pair is ambiguous, decode one more frame on each side before saving the boundary. Give every confirmed shot its own row in the shot inspection, including brief inserts and close-ups. Use the visible target tracks within that row. Record changes in framing and visible tracks in separate inspection rows. Adjacent shots may share a generation window. If the framing or visible cast changes abruptly, verify the adjacent frames before classifying it as camera movement. For scene detection candidates inside a proposed shot, record why each is a cut or continuous motion. Check the first and last decoded frames on both sides of every boundary for short inserts or transitions with no visible feature in scope. Preserve those frames directly from the source. Treat a separate shot whose visible features are outside the replacement scope as its own source-only interval, even when the adjoining shot is in the same scene.

- The shot timeline records source ranges, cuts, framing changes and action.
- The person visibility timeline records each source person's track ID, visible cues, appearances, occlusions, departures and interactions. For each solo close-up, put a frame from it beside a shared view showing the candidate tracks at readable size. Assign the track from matching visible features and record the cue and frame numbers. Leave ambiguous assignments unresolved until there is enough evidence.

Record an inspection row for each shot in the exact model input, including reversed playback and extra source context. List shots in input playback order with their source frame range, visible assigned track IDs, and confirming frames. Record an empty set for shots with no assigned person. Keep the same track through position changes, brief occlusion, and re-entry. Record a foreground object, affected track, and evidence frame only when the object actually covers an area being replaced. Use these rows to build the prompt inputs.

## Use prior results to choose a plan

Check whether the current project already has a usable plan, or whether the user specified one for this edit. Match asset fingerprints when available, then check cuts, frame coordinates and person assignments. Reuse a validated plan if the replacement scope and guide behavior also match. Bind the current project assets and nodes. For a fresh project without a supplied plan, start from the observed footage.

If an earlier take with the same inputs repeated actions, lost an identity or shifted a cut, correct that window or join in the first plan. Record the observed defect, the proposed change and how to test it. Keep any guide needed at that join. For new footage, plan from the observed cuts and tracks.

## Choose segments for multiple replacements

Group adjacent shots with reliable track bindings within the frame budget. If generation must split, inspect both sides of the join and the actual first model input frame, including after reversal. If a visible assigned face is obscured by a hand, prop, hair or another person, move the split to a nearby stable frame where faces are clear or keep the occlusion in one generation window. Preserve source cuts and assembly trims within the window. Aim for about five seconds per generation window, measured in actual model input frames including context and guide overlap. At 24 fps, 120 frames align upward to 124 frames. Cap each generation at six seconds including real context and overlap. Split continuous shots that exceed the cap at stable poses, plan overlap and guides as needed, and preserve the full source action and timing. Place splits where the edited features are fully visible, the source tracks are identifiable, and poses are stable. Move splits away from entrances, exits, clipped faces, and critical occlusion. When neighboring short shots share a window, preserve their original cuts and changes in visibility.

| Observed source event | Planning decision |
|---|---|
| Several selected people remain identifiable during one continuous action | Keep them in one segment when supported; give each a separate mapping. |
| A selected person enters later | Include enough context to identify them. Use an entry-focused segment or a later anchor if needed. |
| Selected people leave and the scene continues | Consider a boundary once the departure stabilizes. The remaining people keep their assignments. |
| People cross, overlap or exchange props | Keep the interaction and identity cues in one segment. If a split is unavoidable, carry context on both sides and inspect the join. |
| Adjacent short shots in one scene | Prefer one generation window. Record `shotSubjects` in input playback order and preserve the original cuts in assembly. |
| A boundary needs a separate window | Record `splitReason` with the concrete evidence. Examples include a frame budget overflow, ambiguous track binding, no reliable join, or a comparable take showing that merging breaks the action or cut. |
| A person is temporarily occluded and reappears | Keep the same track if the footage supports it. |

List all selected people visible anywhere in the segment, with their local entrance and exit times. Keep unselected people unchanged. If the cast exceeds the model's reference limit, revise the plan or report the limitation.

### Choose an identity anchor and playback direction

Compare feasible generation joins and the actual first model input frame in both playback directions. Within the frame budget and guide constraints, prefer stable frames with the greatest number of the window’s assigned people visible together and their faces clear. Record candidate frame numbers, visible track IDs, and the choice. If no feasible frame shows them together, choose the clearest feasible frame and record the limiting constraint. Keep source cuts in assembly.

Adjacent generation windows may overlap. Choose the actual input start where the assigned people are clearest and most complete, then extend the window with consecutive source picture and audio to cover the delivery range. Reverse the entire input window if needed. Each model input still follows the frame grid (`17k+5`, minimum 107 frames) and the six-second cap. Trim context and overlap during assembly so each source frame is delivered once.

For continuation, map both raw donor indices back to source frames and align them with input slots 0 and 21 in playback order. Inspect which assigned people are identifiable in each guide. If neither guide shows the same assigned person clearly in a multi-person window, replan the windows and joins or use an independent anchor where everyone is visible. If no feasible plan exists, report the constraint and wait for the user.

Before cutting a guided anchor, inspect both ends of each candidate window. Record the source frame numbers and which assigned people you can distinguish. Check nearby frames if an endpoint is blurred, occluded or on a cut. Consider a later window when people enter gradually.

Choose the endpoint that establishes the clearest person-to-portrait mapping and supports the joins. If the early endpoint wins, generate forward. If the later endpoint wins, reverse the full input window, including context. If both are equally clear, choose for the joins. If neither works, inspect another window.

Declare one unguided anchor per inspected continuous shot. All other generated segments in that shot need guides. Earlier footage can continue in reverse and later footage forward. Record the chosen endpoint, visible tracks and rationale. The group uses the raw upstream result from the same execution for the dependent guides.

## Produce a concrete plan

Save `segment-plan.md` in the execution directory before cutting clips or creating generation nodes. State the normalized source asset, delivery frame count, frame rate and soundtrack policy at the top, using `frame-plan.json`. Record the model settings and source audio ranges used for generation. For each retained interval, record the source range, shot, reason for the boundary and assembly range.

Place a monospaced ASCII diagram near the top of the plan using the final frame plan values. Show half-open source ranges in playback order, source passthrough, reused generation windows, actual model inputs, anchors, continuation direction, and guide sources. Wrap wide diagrams by scene. This example illustrates the format.

```text
Source order:    [0,6) [6,48) [48,96) [96,102) [102,144)
Delivery:        SRC   W1     W1      SRC      W2
Model inputs:    W1 [6,113)    W2 [80,187)
Generation:      W1 (anchor) --[guide 74,95]--> W2 (forward)
```


- `Keep source` marks an untouched shot, including a one-frame insert. Use the actual source on the final timeline at its original cuts. A generation window can still include that shot as context.
- `Generate` adds person-to-portrait assignments and replacement scope, direction and dependencies, guide source and raw indices, context and overlap, requested duration and raw frame count, and any reverse prefix and output keep range.

Use half-open ranges `[start, end)` and name the frame coordinates for source, raw output and assembly. For a full edit, the retained ranges cover frame 0 to the last frame once.

Record the model input range and assembly keep range separately. When the input is too short, extend it later on the source timeline with consecutive original picture and audio until it meets the model frame requirement. Near the end of the source, move the window start to an earlier stable frame or merge with the preceding segment and validate again. Never add repeated, frozen, or looped frames or insert silence to reach the required duration. Trim context-only footage in assembly. After moving or reversing the window, recompute keep ranges and guide indices from source coordinates. Verify the first and last kept frames, original cuts, and source-only intervals.

- Budget raw frames for the retained edit, context and overlap. For MiniMax-H3 and FastH3 reference generation, use the smallest supported `17k + 5` count that fits the budget and the model's minimum duration. At 24 FPS and a 4-second minimum, the first aligned count is 107 frames, or 4.458333 s. Five seconds is 120 frames and rounds up to 124. If the count exceeds the six-second cap (141 frames at 24 FPS), choose another action boundary.
- When reviewing group results, verify each adopted output's actual frame count and FPS. Use raw output indices for guides. Check the planned keep range against the observed action and cuts. A corrected range should remove verified overlap and context-only footage once.
- Standalone vLLM-Omni cached-latent `continuation` (outside `group.publishRun`) uses hidden overlap on the `17k + 5` grid and returns new frames in groups of 17.

For a long shot with several distinct gestures or changes in who is visible, choose shorter guided windows at stable poses before generation. When a prior result shows a late or repeated action, compare the source and output frames to locate where timing first diverges. Prefer shorter windows with a guided overlap before that action. Put the join where pose and framing match and verify that the assembled action happens once at the source time.

## Keep source audio in reference clips

Trim video by frame range and audio to the same source time range. Reset timestamps after trimming and probe frame count and audio/video duration after encoding.

Keep synchronized embedded source audio in each reference clip when present, including real context and guide overlap. Reverse the trimmed audio and video together for reverse generation. Before import, probe audio and confirm that it matches the picture duration within one frame and satisfies the deployment limits. If the durations differ, trim both again to the same source interval and probe. Set delivery audio separately on the timeline.

## Prepare the plan for execution

Once the frame plan passes, [write prompts](prompt-writing.md) for the generation intervals. For a multi-segment request, [build the canvas](workflow.md#2-build-the-canvas), then [publish the group with its readable plan node](workflow.md#publish-and-verify-the-plan) before starting it. For a plan-only request, deliver the Markdown.

### Validate frame ownership

Save `frame-plan.json` alongside `segment-plan.md`.

- `totalFrames` is the normalized source frame count. `sourceOnly` lists the untouched intervals.
- `delivery.fps` is the integer timeline frame rate. Record the exact delivery soundtrack version in `delivery.audio.asset` once bound to the group timeline.
- Each `segments` entry records `id`, input `source` range, requested `rawFrames` and `reverseLimit` if used. Record the planned anchor or guide and each generation node's `itemId` once the canvas is built.
- Each `timeline` entry records the `source` range and `owner` as `source` or `generated`. Generated entries also record `segment` and the `keep` range after any reversal. Before validating the saved timeline, add the exact `asset` for each clip from the approved source, job result or trim receipt. Record `assetInFrame` when a trim or reversal rebases the clip's first retained frame. The default is the first `source` frame for source clips and the first `keep` frame for generated clips. An `AssetRef` contains `assetId`, `revision`, `fingerprint` and `kind`.

For a new plan, save `shot-inspection.json` before choosing generation windows or an assembly method. Record `totalFrames` and `shots`, covering the full source in order. Each row has `source: [start, end]` and `selectedTracks`, the IDs of people with visible features in the requested scope. Use `selectedTracks: []` for untouched intervals. They stay source-owned on the final timeline even when a generated clip includes them as context. The validator requires an assembly boundary whenever adjacent inspected shots have different `selectedTracks` sets. Set `requiredTimelineCut: true` for other verified cuts that must also remain separate in assembly. Change the inspection only when the source frames support the correction. For the replacement preflight, add `sourceFingerprint` (`sha256:` plus the SHA-256 of the normalized source), and `identityMap` keyed by stable track ID. Each value has `cue` (verified English source-person cues) and `portrait` (the pinned image `AssetRef`). Add `trackFrames` to each shot, mapping each selected track to a confirming source frame inside that shot. Record only the identities visible in scope. Independently inspect the very first and last decoded frames and the two frames around each cut, including one-frame inserts. Record out-of-scope frames as their own source-only ranges. Add `frameTracks`, keyed by the exact source frame number, for every actual model input first frame and the two slot frames of each continuation. Use `[]` for a frame with no identifiable assigned track. An anchor must start with an identifiable subject. Prefer a clear all-subject frame and compare both playback directions. A guided segment must show every assigned subject across its two guides. In each `segments` entry, record `portraits` as the ordered track IDs matching the pinned image slots, `clip` as the local path of the prepared input, and `video` as its exact video `AssetRef` after import.

Assembly intervals on either side of a cut can reference the same generation node with separate keep ranges. Passthrough intervals use the original source. Reuse generation for identical source range, frame count, direction, portraits and guides. When several windows each deliver less than half their raw frames, record why each short window needs to remain separate before publication. Record verified face occlusion as `occludedFaceRanges`, a list of objects with a half-open `source: [start, end]` range and the assigned `track` ID. Write `[]` only after checking. Before cutting clips, run the preflight below. It rejects covered faces at generation joins and at the first frame actually sent to the model. It also checks whether neighboring forward anchors with the same ordered portraits can share a real input window after shifting it, including across source-only inserts. For a short guided tail, check whether moving the join can distribute retained frames while preserving guide overlap. Recompute guides and trims after changing a join.

Run `python3 "$SKILL_DIR/scripts/validate_frame_plan.py" frame-plan.json --enforce-window-limit --inspection shot-inspection.json --normalized-source "$NORMALIZED_SOURCE"` before making clips or publishing the plan. Set `SKILL_DIR` to this skill's directory and `NORMALIZED_SOURCE` to the uncut working copy. Use its decoded frame count for `totalFrames`. The local frame plan records inspection and delivery checks. The published `runPlan` is the executable input and must match it. [Review the decoded take](workflow.md#review-and-retry-a-take) for identities, guides and timing.
