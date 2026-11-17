# Timeline text acceptance fixtures

Captured from baseline `28f30454ffba68907903c6d08db6bb8ba3b8bee2` before adding text contracts. `legacy-project/` contains the actual `project.create`, `editor.create`, and `editor.save` commit bundles, including their original commands, receipts, snapshots and fingerprints. No user project, credentials, machine path, or session database is included. The project has an empty visual track; the saved FPS changed from 24 to 30. Tests copy it into isolated temporary storage and replay its commands without changing the bytes.

All media files were generated locally with FFmpeg lavfi (solid blue/red and 440/660 Hz sine); redistribution is unrestricted. Both video sources are 3 seconds, 24 fps, 640×360; audio sources are 2 seconds, mono PCM at 8 kHz. No model or remote service was used.

`scenarios.json` fixes logical IDs and expected times for subsequent implementation tasks. Resources are fixture filenames, never project asset IDs. Import each file into the isolated target project before constructing formal references. The default font and its license are supplied by the font task; invalid font bytes are a separate negative fixture. Missing-glyph tests must select a codepoint absent from the pinned font's cmap rather than assume a glyph is absent.

Baseline Node timeline/export checks: 12 passed. Baseline Python storage/render checks: 72 passed, 2 pre-existing failures in `test_byte_verified_cache_detects_rewrites_with_unchanged_file_signature[head|ancestor]` (expected ProjectError not raised). These are not text-feature successes and are tracked independently.
