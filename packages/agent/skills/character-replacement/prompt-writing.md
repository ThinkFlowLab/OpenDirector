# Prompt writing

## Governing principle

**Specify which source person gets which portrait and which features to replace, let the source video determine the performance, camera and scene, and describe a critical existing occlusion in one sentence about what stays in front.**

Apply this principle first when writing or revising a prompt. It governs how to use the template, examples and upstream guidance.

Use English for the generation prompt and the user's language for the explanation. In the Agent snapshot (or `.agents/upstream/minimax-h3/skills/h3-prompt-writing` in a source checkout), use the sibling `../h3-prompt-writing/SKILL.md` and `../h3-prompt-writing/references/ref-en.txt` for field names and tag syntax only. Follow this skill's rules for what goes into the character-replacement prompt.

## Planning prerequisite

For new footage or a new multi-segment workflow, complete the [shot timeline, person visibility timeline and segment plan](video-segment.md) before writing prompts. For an existing segment correction, inspect the affected footage. Change the plan only if its boundary or person mapping needs correction.

## Establish the mapping

Inspect the source video and the references in request order. If you cannot inspect the media, state the limitation and use the user's explicit mapping. Ask if the mapping is ambiguous.

- Use one `<Subject N>:` row per bound portrait. Name the assigned picture and the verified source performer in the same row. State the replacement scope and source performance to retain in the summary.
- Record a frame that identifies each source person. Ground left and right in a verified shared shot and use cues such as hair or eyewear. A source feature can identify a person even when the corresponding portrait feature replaces it. Keep the assignment through cuts, single-person shots and re-entry. For a solo shot, identify the visible person by their verified source features. Use left or right from a shared shot only in the plan's identity map.
- If several people in one picture make the target ambiguous, use a crop that isolates the target, preserves the requested features and fits the model's input dimensions. Probe the final crop before binding it. FastH3 reference images require both sides to be 256–5760 pixels and a width-to-height ratio of 0.4–2.5. Use a clearer reference if needed. Multiple views of one person define one target identity.

## Resolve the replacement scope

Use the supplied prompt or the user's feature-by-feature request. For an unqualified face swap, use the portrait's face, hairstyle and eyewear, including whether the person wears glasses. Keep the source clothing, body, performance and scene. "Face only" keeps the source hair and eyewear. If a retained garment or accessory defines a visible action, pass its verified source description in `retainedDetails` for that track and keep the gesture itself in the video. "Keep the original hairstyle" overrides hair only.

For a general character replacement with no feature list, use the assigned picture's appearance. Record the scope in the plan and apply it throughout the prompt.

For face or head replacement, make a rectangular crop from the original portrait around the complete target head. Leave room for the crown, both sides, ears, chin and visible long hair. Keep the crop boundary clear of the head silhouette. Background, collar or some shoulder pixels may remain at the edges. Avoid cutouts, circular masks and gray fills. If the original is missing a required feature, use a more complete reference. When replacing clothing or full appearance, keep all features needed for that scope.

Inspect the actual crop before binding it. Confirm that the required features are intact and the image meets the model input requirements. Register the crop as a derivative of the original, record its source in the segment plan, and verify the ordered portrait asset IDs and versions before publishing.

## Compile the prompt

For new footage, [run the replacement preflight](workflow.md#publish-and-verify-the-plan) to build prompts. It derives `tracks`, `shotSubjects` and `timelineGuides` from the inspected source and the actual input window, including extra context and reversed playback. Put only scope, audio and other optional settings in `prompt-options.json`. Include an occluder only with an `object` and an in-window `evidenceFrames` entry in `occludedFaceRanges`. The builder below describes the rendered template. Set delivery audio on the timeline.

**Do not write storyboard directions in the generation prompt, with or without timecodes.** Directions that stage an opening, call for a cut, reorder shots, or choreograph action, camera movement, framing, lighting, or background can cause H3 to redraw the scene. Keep timecodes and frame indices in the segment plan, guide settings, and trim settings.

In `detailed_description`, let `<Video 1>` supply the performance, camera and scene. Inspect the first and last frames of the exact clip supplied to the model and both sides of each relevant cut. Use `[Shot N]` only to identify an existing shot and state the source-track-to-picture mapping for that shot. Once a source track is defined, use its subject tag in the edit instructions. Keep source traits that will be replaced, such as the original hairstyle, in the track definition. For out-of-scope wardrobe and props, refer to the source video collectively. For a head-only edit, leave individual wardrobe and prop names out of retention and edit instructions unless the user asks to control one or it directly explains a verified occlusion in the kept frames. If an inspected foreground object covers the edited area, name it once via `foregroundOccluder` so it stays in front of the replacement wherever it covers the source person. Let the video control its motion and visibility. Keep inventories of wardrobe and props in the plan.

When a cut changes which selected people are visible, state each visible source track and its assigned picture in that `[Shot N]` line. In a close-up with one selected person, name only that track and picture. When a person leaves within a shot, tie the departure to that person's assigned appearance.

### Build the node prompt

`build_head_prompts.py` validates the structured input and renders the fixed six-section [Jinja template](scripts/head_prompt.jinja). Jinja2 is installed with OpenDirector.

Run `opendirector skill-script character-replacement/scripts/build_head_prompts.py prompt-inputs.json > prompts.json` (or pass `-` to read the same JSON from stdin). It writes a JSON map from segment IDs to complete prompts on stdout:

```json
{"S1":{"tracks":["left performer in a green jacket","right performer in a red jacket"],"sourceAudio":true,"shotSubjects":[[],[1,2]],"timelineGuides":false}}
```

- `tracks`: In portrait binding order, give each source person a short, distinctive noun phrase. Use a verified visible feature plus their position or depth relative to the other people in a shared shot when available. Anchor the spatial cue to that shot (such as the opening two-shot) so crossings and close-ups do not relabel people. Subject definitions identify the source person. The summary specifies the replacement mapping and scope.
- `scope`: `face_only`, `head` (default: face, hairstyle and eyewear), or `appearance` (also clothing and worn accessories).
- `sourceAudio`: describes whether `<Video 1>` carries synchronized source audio. `timelineGuides`: `true` only when the segment has configured guides.
- `dialogueBinding` (optional): one-based integer `shot` and `subject`. Set it only when synchronized source audio is present and the speaker is verified in that shot. The subject must be assigned in the corresponding `shotSubjects` entry.
- `portraitAppearanceOnly` (optional boolean): after a take reproduces a reference photograph as a shot, set this on the affected segment to explicitly restrict portraits to appearance and preserve source framing and background.
- `completeHairReplacement` (optional): set the one-based subject number for a controlled retry when source hair remains behind the ears or at the nape. Requires a scope that replaces hair.
- `targetHairOutline` (optional): use the one-based subject number when testing an exposed-ear and exposed-neck hairstyle verified in its portrait. This replaces the `completeHairReplacement` trial wording.
- `shotSubjects`: derived from the inspected shots in actual input order, mapping each visible track ID to its 1-based index in the segment's ordered portrait bindings. List only the confirmed track in a solo close-up and use `[]` when nobody is assigned. Omit only after verifying the input is one shot containing all bound tracks.
- `eyewear` (optional): one boolean per bound picture when replacing eyewear (`scope` is `head` or `appearance`).
- `foregroundOccluder` (optional): short object name only when an inspected source frame shows it covering the edited area. Omit if it passes without covering that area.
- `preservedPeople` (optional): list of short verified source cues for unselected people whose own appearance and visibility must stay tied to `<Video 1>` during crossings or occlusions.
- `retainedDetails` (optional): list aligned with `tracks` (`string | null`) naming a retained garment or accessory that directly defines a visible action for that track.

The tool owns all six section headers, numbering, and sentence patterns. Save the generated strings verbatim. To revise a prompt, update the structured input and rebuild. Before publishing, run `python3 "$SKILL_DIR/scripts/check_prompt.py" prompts.json` for the structure check. Where an independently approved prompt baseline exists for the same segments and inputs, export the saved node prompts under the same segment IDs and run `python3 "$SKILL_DIR/scripts/check_prompt.py" saved-prompts.json --expected approved-prompts.json`. A mismatch reports the segment and first changed line.

The template emits these fixed forms in `detailed_description` in input playback order:

For this section, supply only `shotSubjects`. The template renders the shot mappings, preserves the existing cuts, and links a later solo shot to the same opening source track. Occlusion, eyewear and guides use their structured fields in retention analysis.

```text
[Shot 1] <Subject 1> -> <Picture 1>, <Subject 2> -> <Picture 2>.
[Shot 2] <Subject 2> -> <Picture 2>.
Preserve the original cut between these shots in <Video 1>.
Shot 2 stays on <Subject 2>, the same source performer as in the opening shot.
```

## Segment prompts

Carry the same person assignments across segments. Update portrait numbers to match each request's input order. Reuse an approved, compliant prompt verbatim when source range, timing, direction, scope and ordered references match. If an input changes, revise the structured input, rebuild, and check it against the new input.

## Diagnose and verify

For a prompt-only comparison, start from the baseline verbatim and change one structured field or phrase to test a specific hypothesis. Freeze the segment, ordered asset versions, guides, seed and model settings. Compare the same track and frames with the source and baseline.

- If identities mix or drift, check the actual picture order and request inputs. Inspect the first affected cut, occlusion, departure or join. Correct the mapping if it follows screen position instead of the source person.
- If clothing or an accessory changes, check feature ownership in the plan and `retainedDetails` before editing the prompt.
- If an unselected person changes during a crossing, locate the first affected frames in the source and output, then add that person's verified cue to `preservedPeople` and rebuild.

## Check the saved prompt

Before submitting, read the saved generation spec and ordered references with `opendirector project show` or an equivalent project query. Check that the saved prompt contains no storyboard directions and that every `[Shot N]` marker matches the exact referenced clip, including its first frame. Resolve plain tags by input order within their media type and structured tags by saved reference ID. Check the six sections, one-to-one assignments, feature ownership, and configured guides against the plan. Fix mismatches, rebuild or update, and read the saved spec again.

For a prompt comparison, hold the inputs, model and effective deployment settings fixed. Review the take against the source at the reported defect and follow the [take review and retry rules](workflow.md#review-and-retry-a-take).
