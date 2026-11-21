# MiniMax-H3 Cinematography & Prompt Grammar

MiniMax-H3 (`MiniMax-H3`, `MiniMax-H3-Max`, `MiniMax-H3-Highspeed`, `MiniMax-H3-Lite`, and `vllm_omni` / FastH3 deployments) expects structured English prompts with exact section order, natural-English camera actions, sequential `[Shot N]` markers, and strict per-modality reference ordinals.

## 1. Choosing the H3 Mode

| Mode | CLI `video create` flags | Prompt structure | Best use case |
| --- | --- | --- | --- |
| `t2va` | *(no media flags)* | 3 core sections (no alignment header) | Pure text-to-audiovisual shot when no visual anchor exists yet |
| `i2va` | `--first-frame <ITEM>` | `I2VA` alignment line + blank line + 3 core sections | Forward action starting from an anchor keyframe at `0.00s` |
| `fl2va` | `--first-frame <ITEM> --last-frame <ITEM>` | `FL2VA` alignment line + blank line + 3 core sections | Controlled state/pose/camera transition bridging two keyframes (prefer single shot) |
| `l2va` | `--last-frame <ITEM>` | `L2VA` alignment line + blank line + 3 core sections | Plausible preceding action converging onto a target landing frame at `S.SSs` |
| `ref2va` | `--reference-item <ITEM> ...` | 6 full-reference sections | Multi-subject identity consistency, voice timbre reference, or source-video structure/editing |
| `continuation` | `--continue-from <VIDEO_ITEM>` | Continuity prompt extending prior latent tail | Seamless multi-segment extension on `vllm_omni` (`17n+5` frame grid at 24 fps) |

Duration bounds are `4.0–15.0` seconds per H3 generation. On 24-fps FastH3 / `vllm_omni`, frames snap up to `17n + 5` (for example `5s -> 124 frames`, `7s -> 175 frames`).

## 2. Exact Alignment Headers (`I2VA` / `FL2VA` / `L2VA`)

Place the alignment instruction on line 1, followed by **one blank line**, where `N` is the final `[Shot N]` index and `S.SS` is the target duration to two decimals:

- **I2VA**:
  `For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.`
- **FL2VA**:
  `How the reference pictures align with the target video — Picture 1 (from Shot 1) aligns with the 0.00-second mark of the target video; Picture 2 (from Shot N) aligns with the S.SS-second mark of the target video.`
- **L2VA**:
  `How the reference pictures align with the target video — <Picture 1> (from [Shot N]) aligns with the S.SS-second mark of the target video.`

`T2VA` and `Ref2VA` never include a keyframe alignment header.

## 3. Core Sections: Base (`T2VA` / `I2VA` / `FL2VA` / `L2VA`) vs `Ref2VA`

### Base 3-Section Order
1. `integrated_multimodal_description:` — Style + `[Shot 1]` (never timestamped) + optional `[Shot 2] At MM:SS.mmm, the camera cuts to ...`, including subject actions, camera motion, `(S1)` dialogue `<d>[Language] ...</d>`, and synchronized diegetic sound.
2. `overall_soundscape:` — 1–4 sentences of continuous room tone, weather, footsteps, cloth, and non-verbal human sound across the clip (`N/A` only when explicit complete silence is requested). Never put `<d>` here.
3. `non_diegetic_music:` — 1–3 sentences describing instrumentation, tempo, and dynamics of audience-only score (avoid abstract mood words; use `N/A` when unscored).

### Ref2VA 6-Section Order
1. `subject_definitions:` — One line per tracked `<Subject N>`, frame-anchor `<Picture N>`, structural `<Video N>`, or `<Audio N>`. Cite source images inside `<Subject N>` definitions when used only for identity/style.
2. `summary:` — Must begin with `[task type]` combining `keyframe completion`, `reference generation`, `video editing`, `video continuation`, `audio reuse`, or `audio reference` with ` + `.
3. `retention_analysis:` — One line per label using fixed markers (`fully_preserved`, `partially_preserved`, `attribute_transfer`, `weak_reference` for visual labels; `fully_copy`, `partially_copy`, `reference`, `weak_reference` for `<Audio N>`). Never write `(S1)` speaker IDs in `retention_analysis`.
4. `detailed_description:` — 1–2 style sentences **before** `[Shot 1]`, followed by shot-by-shot playback description weaving `<Subject N>`, `<Picture N>`, `<Video N>`, `<Audio N>`, and `(Sx)` `<d>[Language] ...</d>`.
5. `overall_soundscape:`
6. `non_diegetic_music:`

## 4. Reference Ordinal Rule (`<Audio N>` Offset)

OpenDirector's FastH3 adapter numbers each modality in reference order, **reserving `<Audio 1..K>` for reference videos that contain an audio stream (`hasAudio: true`) before standalone audio references**:

- Example: Reference 1 = `hero.mp4` (`hasAudio: true`), Reference 2 = `voice.wav` (`audio`).
  - `hero.mp4` -> `<Video 1>` (and embedded soundtrack `<Audio 1>`)
  - `voice.wav` -> `<Audio 2>` (not `<Audio 1>`!)
- Always run `opendirector video lint-h3-prompt --spec-id <SPEC_UUID>` before `generation submit` to inspect `referenceOrdinals` and catch off-by-one `<Audio N>` tags automatically.

## 5. Camera Vocabulary & Framing Variety

Express camera movement as a **natural English action** inside the shot sentence rather than comma-separated tags at the end:

- **Shot sizes**: `extreme wide shot`, `wide shot`, `medium-wide shot`, `medium shot`, `medium close-up`, `close shot`, `close-up`, `extreme close-up`, `over-the-shoulder shot`, `two-shot`, `low-angle shot`, `high-angle shot`, `overhead shot`, `bird's-eye shot`.
- **12 H3 motion families**: `Zoom In` / `Zoom Out`, `Push In` / `Pull Out`, `Pan Left` / `Pan Right`, `Truck Left` / `Truck Right`, `Tilt Up` / `Tilt Down`, `Pedestal Up` / `Pedestal Down`, `Arc Shot`, `Tracking Shot`, `Static Shot`, `Shake Slightly` / `Shake Strongly`, `POV`, `Roll Clockwise` / `Roll Counterclockwise`.
- **Amplitude & speed** (omit medium/normal): `with small amplitude` / `with large amplitude`, `at slow speed` / `at fast speed`.
- Example: `The camera pushes in with small amplitude at slow speed toward the brass key in her palm.`

## 6. Dialogue, Voiceover, and On-Screen Text

- Assign `(S1)`, `(S2)` in order of first vocal event; reuse across shots. Non-speaking characters receive no speaker ID.
- Keep verbatim spoken words and original language inside `<d>[Language] ...</d>`:
  `The calm detective (S1) says: <d>[Chinese] 先别动那封信。</d>`
- Off-screen voiceover must use `says in an off-screen voiceover:` and state closed lips immediately after `</d>`:
  `The man (S1) says in an off-screen voiceover: <d>[English] We never returned.</d> while his lips remain completely closed.`
- Use `<scenetrans>` on both sides when speech crosses an internal `[Shot N]` cut, and `<cutoff>` when truncated by clip end. Quote visible signage/text verbatim in English double quotes (for example `"24H OPEN"`).
