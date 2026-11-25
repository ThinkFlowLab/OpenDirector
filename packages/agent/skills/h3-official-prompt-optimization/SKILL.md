---
name: h3-official-prompt-optimization
description: Rewrite a MiniMax H3 video draft into the model's official prompt structure (instruction line plus integrated_multimodal_description, overall_soundscape and non_diegetic_music) while preserving OpenDirector's inline reference markers. Use to compare output against h3-prompt-optimization.
---

# H3 official-structure prompt optimization

Rewrite the draft into the structure MiniMax documents for H3 generation modes
(T2VA, I2VA, FL2VA, L2VA, Ref2VA). Keep the draft's own language for everything
descriptive; the structure and its tokens are English. Return only the rewritten
prompt.

## Hard invariants

- Keep every `[[OD_REF_n]]` marker exactly once and in its existing order. These
  markers are the editor's inline references; never delete them, renumber them,
  or move them into a different shot.
- Write the description text in the draft's language. A Chinese draft stays
  Chinese; do not translate it into English.
- Never translate the structural tokens. Field names, `[Shot N]`, the cue tags
  `<d>`, `<scenetrans>`, `<cutoff>`, `<Picture N>`, `<Video N>`, `<Audio N>`,
  speaker ids such as `(S1)`, and the mode instruction line stay exactly as this
  skill writes them, in English. A translated token is a broken prompt.
- Keep dialogue, lyrics and visible on-screen text verbatim in the language they
  were supplied in.
- Do not invent references, dialogue, sound or shots that the draft and its
  references do not support.

## Skeleton

```text
<optional mode instruction line>

integrated_multimodal_description: [Shot 1] ...

overall_soundscape: ...

non_diegetic_music: ...
```

Leave one blank line between the three fields. Ref2VA replaces them with its six
sections in order: `subject_definitions`, `summary`, `retention_analysis`,
`detailed_description`, `overall_soundscape`, `non_diegetic_music`.

## Mode instruction line

The instruction line is a fixed English sentence. Write it as given; only the
field contents below it follow the draft's language.

T2VA has no instruction line; start directly with
`integrated_multimodal_description:`.

First-frame mode: the first line is exactly

```text
For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.
```

First-and-last-frame mode: the first line states how both pictures align, naming
the shot each picture comes from and the exact second mark, formatted to two
decimals.

Last-frame mode: the first line aligns the single picture with the final
`[Shot N]` at the duration's second mark. That picture belongs to the last shot,
not to Shot 1.

## Shots

- `[Shot 1]` carries no timestamp. Later shots are `[Shot 2] At 00:03.500,
  镜头切到…`, each with a strictly increasing time inside the duration. The time
  notation and `[Shot N]` stay in English; the sentence after them follows the
  draft's language.
- Ordinary cuts use the draft's language: `镜头切到`, `画面转到`, `镜头转换为`,
  or, in an English draft, `the camera cuts to`, `the shot cuts to`, `the shot
  transitions to`, `the shot changes to`, `the shot switches to`. Use
  cross-dissolve, fade or wipe only when the draft asks for them.
- A cut must bring new information: subject, space, state, viewpoint or time. To
  change only distance or a slight angle, use camera motion instead.
- Open `[Shot 1]` with the overall style and the initial composition, written in
  the draft's language: `写实电影感，中景，画面框住…` or
  `Live-action, cinematic, a medium-wide shot frames …`.

## Camera motion

Write motion as a natural action inside the sentence, never as tags appended to
the end: motion type first, then amplitude and speed only when they matter. Omit
amplitude and speed for ordinary movement. Use the draft's language.

```text
The camera pushes in with small amplitude at slow speed toward the folded letter.
镜头缓慢推近，小幅，推向她手中的信。
```

Motion types, in the draft's language: 推近 / 拉远, 横摇左 / 右, 横移左 / 右,
上摇 / 下摇, 升降, 环绕, 跟拍, 固定镜头, 轻微抖动 / 强烈抖动, 主观视角,
顺时针 / 逆时针旋转. The English set is zoom in/out, push in/pull out, pan
left/right, truck left/right, tilt up/down, pedestal up/down, arc shot, tracking
shot, static shot, shake slightly/strongly, POV, roll clockwise/counterclockwise.
Amplitude: `小幅` / `大幅` (small/large amplitude). Speed: `慢速` / `快速`
(slow/fast speed).

## Speakers and dialogue

- Give every speaking, singing or off-screen voice a stable id `(S1)`, `(S2)`;
  joint lines use `(S1,S2)`. Characters who never vocalize get no id.
- Outside `<d>`: the identifying phrase, the id, the action and the delivery.
  Inside `<d>`: only the language tag and the draft's exact words, untranslated.
- Off-screen narration keeps the official English phrase `says in an off-screen
  voiceover`, and must add, in the draft's language, that the on-screen
  character's lips stay closed.
- A line crossing a cut uses `<scenetrans>` at both ends and states that the
  audio continues; speech truncated by the video end uses `<cutoff>`.

```text
The young woman (S1) says: <d>[Chinese] 没事，我下站就到。
年轻女子（S1）轻声说：<d>[Chinese] 没事，我下站就到。
```

## On-screen text

Put visible banners, signs, labels or neon text in ASCII double quotes rather than
CJK corner brackets, and keep the original characters and punctuation
untranslated.

## overall_soundscape

One continuous paragraph of 1–4 sentences in the draft's language, covering
ambience, physical action sounds and non-verbal human sounds across the whole
video. Do not repeat dialogue, singing or diegetic music here. Use `N/A` only
when the draft asks for complete silence.

## non_diegetic_music

1–3 sentences in the draft's language describing music only the audience hears:
instrumentation, tempo, rhythm and dynamic changes. No abstract mood words and no
explanation of the score's emotional purpose. Audio the characters can hear
belongs in the multimodal description instead. Use `N/A` when there is none.

## References

- Cite the official tokens (`<Picture 1>`, `<Video 1>`, `<Audio 1>`) where the
  structure calls for them; the application appends the numbered reference list
  that maps each token to an uploaded asset.
- Place the matching `[[OD_REF_n]]` marker where that reference drives the action,
  so the editor keeps its inline position.
- Keep one role per reference and use it consistently across all fields; never
  reference a token the draft did not supply.

## Output

Return the prompt body only: no analysis, no heading, no code fence, no notes
about what changed.
