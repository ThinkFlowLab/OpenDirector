---
name: seedance-prompt-optimization
description: Refine an existing Seedance 2.0 video prompt while preserving its references, timing, dialogue and audio constraints. Use for prompt rewriting, not generation or an end-to-end production workflow.
---

# Seedance 2.0 prompt optimization

Use these instructions when refining a video draft for Seedance 2.0
(`doubao-seedance-2.0`, `-mini`, `-fast`). Keep the output in the user's
language and return only the rewritten prompt.

## References

- Keep every `[[OD_REF_n]]` marker exactly once and in its existing order.
  Never rewrite a marker as `@图片1` or `[asset-…]`, and never cite a marker the
  draft did not supply.
- Give each reference one role and state it next to its marker at first use:
  `[[OD_REF_1]] 作为首帧`, `[[OD_REF_2]] 的角色形象`, `参考 [[OD_REF_3]] 的运镜`.
  Do not swap, merge or invent roles.
- Keep literal provider tokens such as `<Picture 1>`, `<Video 1>` and
  `<Audio 1>` untouched.

## Structure

Write the prompt in this order:

1. **Global setup** — lock the subject, wardrobe, environment and the reference
   mapping. Declare the first/last-frame constraint here when the mode supplies
   one.
2. **Time-sliced storyboard** — split the requested duration into slices, each
   written as time range, shot size, subject, action, environment, lighting and
   sound. Use the user's notation for time (`0-3秒：` for Chinese drafts,
   `0-3s:` for English ones). The slices must sum to the duration in the
   generation settings.
3. **Edit instruction** — only when the draft asks for replacement, on-screen
   text, extension or removal. Name the time range and the screen position of
   the change.
4. **Stability constraints** — close with the anti-breakdown clause when the shot
   contains characters or fast motion: stable faces with clear features, natural
   non-rigid motion, no stutter and no flicker.

## Craft

- One camera move per slice. When the shot needs a push and an orbit, split them
  into two slices instead of stacking them in one.
- Order actions chronologically and keep each slice legible: a 4–8 second draft
  carries one beat, 13–15 seconds carries three or four slices.
- Keep quoted dialogue exactly as written and name who speaks and when. Keep the
  audio, music and sound-effect requirements the draft states; never invent
  dialogue or sound.
- Make character, wardrobe, lighting and scene continuity explicit when the
  input depends on it.
- In first/last-frame mode describe how the action travels from the selected
  first frame to the last. In reference or continuation mode preserve the
  previous clip's endpoint and momentum.
- For a requested replacement, name the source subject and its replacement and
  preserve positions, poses, timing and the untouched subjects and scene. Add no
  replacement instruction when none was requested.
- Do not add resolution, frame rate, subtitles, watermarks, logos or stylistic
  defaults the draft did not ask for. Resolution and duration are generation
  parameters, not prompt text.
- Do not infer movement, dialogue or sound from reference metadata alone.
- Do not use emoji or decorative symbols inside the prompt.
