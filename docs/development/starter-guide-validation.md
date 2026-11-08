# Starter guide validation

Local implementation on main baseline `7358d3cbf0bc46c830f55e76e2ef578ead862f19`, 2026-11-08. No hosted model calls or keys were supplied. This is a local MVP, not a released feature.

## Checks executed

- `npm test`: 679 passed, 0 failed. Four new tests cover timeline assembly/retry preservation, unrelated-project safety, imported MIME/provenance, and media manifest checksums.
- `npm run build`: TypeScript and Vite passed; existing bundle-size advisory remains.
- `npm run check:i18n`: 2,915 keys, 0 problems.
- `git diff --check`: passed.
- All authored sample MP4s passed full FFmpeg decode. Three source clips: 960×540, H264, 24 fps, four seconds each. Reference cut: 12 seconds.

## Real browser exercise

Isolated desktop Chromium, local API on port 8225 and web app on 5225, separate data root. This used actual project commands/storage and the normal timeline exporter, not mocked receipts or a downloaded reference cut.

- Welcome opened the guide and imported a separate project. Edited story and shot text persisted. Created the reference relationship, adopted a keyframe and assembled three clips.
- Initial browser testing caught the File constructor dropping media MIME types. Fixed explicit PNG/MP4 MIME preservation and added a regression test. Fresh imported videos then reported readyState 4 and four-second duration without playback errors.
- Normal MP4 export: H264, 960×540, 24 fps, 288 frames, 12 seconds, 417,040 bytes. Full FFmpeg decode passed.
- Changed the first clip's source out-point from 4 to 3 seconds through the real timeline editor. Re-export: H264, 960×540, 24 fps, 264 frames, 11 seconds, 428,224 bytes. Full decode passed. This verifies edits affect the deliverable.
- Refresh restored edited text, chosen image, reference, eleven nodes, timeline and step 6. Back/reassemble did not duplicate clips. Skip and Help resumed step 6. Refresh after the trim retained the eleven-second timeline.
- Switched Chinese/English guide copy; existing project names and authored text remain user content rather than being rewritten during locale changes.

## Limits

No native Windows/macOS installation or packaged-wheel test; no screen-reader or comprehensive keyboard/mobile pass; no network fault injection during initial import or cross-window race testing. No new model inference was performed, and this does not assess generated-video quality. Guide navigation hints are browser-local, while project content is server-authoritative. Browser storage clearing does not delete project content. The guide does not fabricate an export-complete state; the normal exporter owns success/failure.

The guide is a task panel with canvas focusing, not yet a full spotlight/anchor framework. More polished keyboard focus transfer and animation can be iterative work without replacing normal business operations.

## Save-race correction

Independent review reproduced a same-project data-loss race: the guide awaited persistence and then installed its earlier whole-document snapshot, discarding intervening canvas edits. The guide now enters the normal editing history synchronously before saving, so later changes build on it; it never reinstalls the captured document after I/O. A project switch or failed save prevents guide progression, without rolling back newer work. Four deferred-save regressions cover intervening edits, project switching, failed persistence, and a queued history conflict. Full suite after correction: 683 passed; build, i18n and whitespace checks passed. The initial real-browser export evidence above predates this correction; controlled race coverage is unit-level unless explicitly recorded separately.
