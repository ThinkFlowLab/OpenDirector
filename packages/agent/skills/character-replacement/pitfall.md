# Failure lessons

| Failure | What to do |
| --- | --- |
| Rebuilding a working group changed several settings at once, obscuring the cause of regressions. | Read back the example group before editing. Keep the prompts, asset versions, model parameters, guide frames and trim ranges fixed wherever they fall outside the requested change. |
| Whole-film retries hid which change helped and regressed shots that already worked. | Compare the smallest failing interval against the source and the last usable result. Freeze the other inputs, change one variable, and define the acceptance check before submitting. Use `group regenerate-run-step` + `group adopt-run-candidate` when only resampling one segment. |
| Prompts that retold the shot or listed incidental props produced wider framing, extra people and invented objects. | Keep the prompt scoped to the appearance change. If an inspected foreground object covers the edited area, describe that occlusion once. Verify the saved prompt and portrait order before starting. |
| A late cut carried the old scene into the next shot. Long unguided windows showed late or repeated gestures. | Inspect decoded frames on both sides of the cut. Preserve frames outside the edit directly and split long action at stable poses when needed. Check donor and recipient guide indices against the source, then review the assembled join in motion. |
| A provider failure looked like a canvas that ignored the click. | Check the group receipt, failed step and provider task ID before changing inputs or retrying. A reachable model list does not prove that inference workers are healthy. |
| A face matched the portrait, while visible source hair survived behind the ear and down the neck. A naturally worn accessory distracted from that failure. | Check each in-scope feature on the same source track. Score clearly visible source hair as incomplete even when the face passes. Judge accessories by the requested scope and how they attach and move. Mark cropped or occluded regions for review. |
| Appending an instruction about the full extent of the hair left the same visible source strands on the output. | Start from the baseline prompt verbatim. Replace one existing phrase to test a specific hypothesis, keep the rest of the prompt and inputs fixed, and compare the same track and frame. |
| Replacing an action description with a generic source-preservation instruction lost foreground occlusion in a close-up. | Keep one verified spatial relationship when an object crosses the edited area. Let the source determine the motion and timing, and compare frames on both sides of the cut. |
| A long continuous shot submitted as one generation drifted in its later actions. | Check the roughly five-second window against actual model input frames before publishing. Split at stable poses and use guides for continuation. |
| Reusing opening positions in a later close-up mislabeled a performer or bound the wrong portrait. | Follow the source track using confirming frames. Check the title, saved prompt, and actual portrait references before publishing. |
| Padding short inputs with freezes or loops, or splitting on partially visible people, degraded motion or replacement quality. | Extend the window with later source frames, split at stable frames where the edited features are visible, and trim extra context during assembly. |
| Omitting the anchor segment field triggered the ordinary video-reference limit. | Save an empty `h3Segment` on anchors and read back the spec and pinned source before diagnosing deployment capability. |
| An input anchor starts on a hand or phone insert, and a one-frame ending gets merged into the last close-up. | Decode the actual first and last frames and the two sides of each cut. Record inserts as source passthrough and use a recognizable frame to anchor generation. Use the same inspection to derive the prompt, then read back pinned portraits and guide indices. |
| With Swap LoRA enabled, a replaced face can look right while its mouth movements fall out of sync with the source dialogue. | Check visible speech against the aligned source audio before and after assembly. If the mismatch is already in the generated segment, rerun the affected segment with only Swap LoRA disabled. Keep Turbo, seed, prompt, references and source window fixed. |
| Extending a short speaking close-up with continuous source footage and synced audio to match the output length did not restore lip sync. A later two-shot appeared early and the target performer remained unreplaced in the reviewed frames. | Use matching frame counts to satisfy the generation length requirement. For lip-sync acceptance, compare the original speaking interval at matching frame indices and verify the shot, speaker, replacement and mouth movements against the source audio. When the cut or speaker drifts, reject the take and change the input strategy before retrying. |
| A prompt clarified who owns the dialogue. Mouth movement mostly stayed on the intended person, but the source close-up still became a continuation of the two-shot. | Verify the original cut and framing, then the speaker track, then mouth timing against the source audio. Reject a take that drops the cut. If the cut instruction has already failed, stop adding equivalent wording and test a visual constraint as a separate variable. |

## One-shot comparison: a two-shot cuts to a speaking close-up

The source cuts from two people in frame to a close-up of one of them speaking. Both shot mappings have been verified, and `<Subject 2>` speaks in the close-up. For multiple source shots, the template emits the cut instruction after the mappings in `detailed_description`. For a comparison, keep the source video with audio, portrait order, model, sampling and soundscape fixed and vary only this line:

```diff
 [Shot 1] <Subject 1> -> <Picture 1>, <Subject 2> -> <Picture 2>.
 [Shot 2] <Subject 2> -> <Picture 2>.
+Preserve the original cut between these shots in <Video 1>.
```

This comparison tests whether the cut survives. Mark the take as failed if the cut is still missing. If the cut and speaker are correct and only lip sync is off, change only `overall_soundscape` in the next test. Tie the speaker's mouth movements to that same performer's original dialogue in `<Video 1>`.

- A dialogue binding can name the right speaker while the result still drops the source cut. Compare frames on both sides of the source cut before judging lip sync. If a two-shot persists through a source solo close-up, reject the take before continuing. In a matched retry, changing only the soundtrack wording to name the speaker still left the solo cut missing. The same cut was still missing with the structured shot-and-speaker binding. Verify cut preservation independently before testing lip sync.

A matched retry that changed only the cut sentence to explicitly request the source solo shot also dropped the cut. When both prompts lose the same hard cut, test separate generation windows with a fixed delivery cut before adding further wording.

A longer real input window may bring back a hard cut but leave the solo performer unchanged. Verify the cut frame and replacement coverage independently; a visible cut alone does not pass.

When a generated shot reproduces a portrait photograph, try only the structured `portraitAppearanceOnly` constraint first. With identical references, seed and sampling, this restored both replacements and kept the source framing through the retained interval in a matched retry. Review the full retained interval and the join before applying it elsewhere.

The portrait appearance constraint can fix photo leakage without fixing a later shot that retains the original performer. If a multi-shot window replaces only the opening shot, verify replacement and timing on both sides of each cut. Test a separate generation window for the affected delivery interval before adding more prompt clauses.

A reverse window that opens on the intended close-up can still generate the neighboring two-shot across the kept interval. Review the exact trim after restoring playback order. If a forward window already keeps the close-up, test that known input and trim at the original cut before changing the dialogue text.

A matched retry with `completeHairReplacement` changed mouth shapes at some sampled frames but left visible source hair behind the ear and at the nape. Treat this wording as an unproven experiment. Verify the hair outline and mouth motion separately before adopting its output.

A second matched wording trial that explicitly required exposed ears and neck also left the long-hair silhouette. After these two failures, keep the best candidate and test visual conditioning before adding another hair clause.

A pinned first-frame image guide can fix a persistent hair silhouette without correcting speech motion. Compare the same retained source frames with and without the guide. Reject the candidate if the original speaker’s mouth timing drifts, even when the head replacement looks complete.

With the same source, portraits, first-frame guide, and seed, replacing the speaker-binding sentence with a frame-by-frame mouth instruction changed the generated mouth shapes but left visible timing errors. Keep this wording experimental. Aligned audio alone does not establish aligned mouth motion.

A reversed input spanning several cuts can contain the correct retained frames and still produce the wrong shot there. Compare the returned clip after the published reversal and trim against the forward source. If the source window is correct, test anchoring the intended shot before changing the timeline trim.

In a matched reverse-window rerun, an image guide made from the intended shot at input frame 0 preserved the tight shot through the retained window. Bind the guide to the generation playback order, then check the result in delivery order.

An image guide for the opening shot can restore a missing close-up while leaving a one-frame shift at a later hard cut. Check returned frames immediately on both sides of each source cut; a restored shot alone does not prove exact cut timing.

A continuation can hold an occluding hand from the guide after the source hand has left. Verify foreground props and body parts across the first retained frames and later frames. A correct guide slot and matching faces do not prove the motion is correct.

Adding the template foreground-occluder clause with the same input and 0/21 guides still left a stale glove. Use the clause for occlusion order. When persistence survives a matched retry, isolate the guide that depicts the old pose before adding more wording.

In Goodnight try0086 C2, retaining only C1 frame 102 at output frame 0 still left a white glove at the right edge after it exited in the source. The single-guide take fails the same retained-frame check as the two-guide take. Hold the guide fixed when testing wording that states the source exit.

MiniMax official PE described the C2 glove as lowering out of frame before the later pointing gesture. The rewrite also introduced an explicit <Audio 1> label and extensive dialogue and scene details. Keep the observed foreground transition as a candidate for a matched wording test. Confirm the runtime reference labels before using the full PE text.

Goodnight try0086 C2 still held the right-edge white glove through the retained interval when the prompt said it leaves at the same time as the source. Eleven matched frames show that the broad exit wording did not correct the motion. Compare the PE-derived lowering cue under the same guide before generalizing.

In try0086 C2, the PE-derived lowering cue changed the output bytes but still left a raised glove at the right edge throughout sampled frames 381–438. Both exit wordings failed with the same C1 frame-102 guide. Hold the source window and delivery trim fixed when comparing a guide made from C2’s own opening.

In try0086 C2, a pinned frame-0 guide made from C2’s own opening restored the glove exit and later pointing in 11 matched frames. The matched PE wording alone had failed with the upstream guide. The C1→C2 join still shows a face-lighting shift, so inspect consecutive frames on both sides before treating the local anchor as a seamless replacement.

In Goodnight try0086 C3, a bedroom continuation preserved the pointing gesture but held the bedroom through the source’s bright-room dance cut at frame 484. The brown-haired solo performer also remained unchanged at sampled frames 532–548. Use independent generation windows for the bright-room dance and the affected solo close-up, with the source cuts fixed. Check both the cut and replacement coverage before assembly.

Splitting the bright-room dance into an independent reverse window restored the source location in try0086, but the retained output still shifted the choreography and kept the source hair silhouettes. Inspect motion and both replacements after reversing and trimming. Test a composition-matched guide at frame 0 of the actual generation input before changing delivery boundaries.
