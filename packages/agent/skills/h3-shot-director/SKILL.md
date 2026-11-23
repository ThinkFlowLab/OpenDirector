---
name: h3-shot-director
description: Direct single-shot and multi-shot MiniMax-H3 videos using canonical cinematography vocabulary, structured T2VA/I2VA/FL2VA/L2VA/Ref2VA prompt compilation, pilot-anchor gates, contact-sheet QC, and surgical single-shot timeline revision.
---

# H3 Shot Director

Translate creative requests or reference videos into executable, visually diverse MiniMax-H3 shot plans, canonical H3 prompts, verified media deliveries, and editable timelines through `opendirector` CLI commands on `PATH`.

Planning or prompt drafting alone never authorizes submitting remote generation jobs. Separate planning receipts, generation execution facts, technical/visual QC, and user adoption.

## End-to-End Workflow

1. **Inspect Project & Reference Footage**: Run `opendirector project show` and `opendirector model list --kind video` first. When adapting a reference video, copy or read it inside the authorized execution directory and run `opendirector video inspect-shot <file> --contact-sheet ./ref-sheet.jpg` to extract stream facts (`durationSeconds`, `width`, `height`, `fps`, `hasAudio`, `matchesH3Grid`) and a timestamped visual contact sheet before planning shots.
2. **Draft & Lint Anti-Homogenization Shot Plan**: Read [shot-orchestration.md](shot-orchestration.md). Produce a shot table specifying `shotSize`, `cameraMotion`, `durationSeconds` (`4–15s`), `mode` (`t2va`, `i2va`, `fl2va`, `l2va`, `ref2va`, or `continuation`), anchor assets, and audiovisual action. Validate the plan with `opendirector video lint-shot-plan --file ./shot-plan.json` so 3+ consecutive shots never repeat the same `(shotSize, cameraMotion)` pair.
3. **Pilot Anchor & Project Continuity Gate**: For multi-shot sequences (3+ shots) or costly cloud runs, bind shared `Subject` or scene anchor assets across shots, generate/adopt keyframe anchors first, and audit the live project graph with `opendirector video audit-storyboard` (`query storyboard.audit`) to catch unanchored `T2VA` islands, unrendered upstream keyframes, or monotonous shot streaks before submitting batch video jobs.
4. **Compile & Lint Canonical H3 Prompts**: Read [h3-vocabulary.md](h3-vocabulary.md). Write prompts strictly in H3's English section structure while preserving verbatim original language inside `<d>[Language] ...</d>` and quoted on-screen text. Use `opendirector video compile-h3-prompt --file ./shot-spec.json` to build structured prompts and `opendirector video lint-h3-prompt --spec-id <SPEC_UUID>` after `video create` to verify alignment headers, cut timestamps, and `<Picture N>` / `<Video N>` / `<Audio N>` ordinals (accounting for embedded audio tracks on reference videos).
5. **Execute, Inspect Across Time & Assemble**: Create nodes with `opendirector video create` (`--first-frame`, `--last-frame`, `--reference-item`, or `--continue-from`), submit authorized jobs, wait with `job wait`, and inspect delivered project video assets across time via `opendirector video inspect-shot --asset <ASSET_UUID>` (or `query asset.preview` with `videoScope="contact_sheet"`). Report deterministic `measuredFacts` (`suspectedFrozen`, `blackFrameIndices`, `matchesH3Grid`, `hasAudio`) separately from your visual/creative review, without importing inspection contact sheets as project assets. Assemble verified clips onto an editable timeline (`editor create` / `editor save`) with `inputConnections` linking each `slotId` to its source shot item.
6. **Surgical Single-Shot Local Revision**: When a user or QC review asks to reshoot or fix one shot in an assembled timeline, regenerate and adopt only that shot's replacement candidate, then run `opendirector video revise-shot --timeline-editor <EDITOR_UUID> --source-item <SHOT_ITEM_UUID>` (or `--clip-id <CLIP_ID> --asset <NEW_ASSET_UUID>`) so neighbor clips, audio tracks, fonts, and text overlays remain untouched.

Resolve relative links (`h3-vocabulary.md`, `shot-orchestration.md`) from this skill directory. Keep user model, resolution, aspect-ratio, and audio choices intact unless explicitly asked to change them.
