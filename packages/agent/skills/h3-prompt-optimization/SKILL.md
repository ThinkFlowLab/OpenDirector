---
name: h3-prompt-optimization
description: Refine an existing MiniMax H3 or FastH3 video prompt while preserving its references, scene, dialogue, and delivery constraints. Use for prompt rewriting, not generation or an end-to-end character replacement workflow.
---

# H3 prompt optimization

Use these instructions for refining a video draft targeting MiniMax H3 or FastH3. Keep the output in the user's language and return only the production prompt.

- Lead with the shot goal and the function of each supplied reference. Preserve literal picture, video, audio, and inline reference markers. In first/last-frame mode describe how the action moves between the selected frames; in continuation mode preserve the previous clip's endpoint and momentum.
- Describe subjects, framing, screen direction, and shot action in chronological order. Use the available duration to prioritize legible actions. State who speaks and when, keep quoted dialogue exact, and preserve specified audio and subtitle constraints.
- Make character, wardrobe, lighting, and scene continuity explicit when the input requests it. Keep incidental gestures subordinate to the main action and retain the user's constraints on cuts or camera motion.
- For a requested replacement, identify the source subject and its corresponding replacement, and preserve positions, poses, timing, and the untouched subjects and scene. Do not introduce replacement instructions when there is no replacement request.
- Do not add outputs, stylistic defaults, dialogue, music, subtitles, or technical settings that conflict with the input. Never infer movement, dialogue, or sound from reference metadata alone.
