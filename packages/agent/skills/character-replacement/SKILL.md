---
name: character-replacement
description: Replace people in source footage with H3 in OpenDirector. Plan segments, write Ref2VA prompts, and publish guided Runs with a visible plan on the canvas.
---

Every generated entry in a published character replacement group must include `replacementPromptInputs`. Only `shotSubjects` drives `detailed_description`. Follow the [workflow](workflow.md) to save the rendered prompt and bindings.

# Character replacement

> For Chinese requests, read [SKILL.zh.md](SKILL.zh.md) and its linked `.zh.md` guides.

**[Governing prompt principle](prompt-writing.md#governing-principle)** — Specify which source person gets which portrait and which features to replace, let the source video determine the performance, camera and scene, and describe a critical existing occlusion in one sentence about what stays in front.

## Choose the path

- **Reuse an example group.** Read back the example group. Carry over the prompts verbatim, ordered references and asset versions, model parameters, guides, trims, and audio policy. Bind equivalent material in the target project and compare the saved configuration before starting. Surface unsupported fields before execution.
- **Retry a segment in a group.** Read the target group, the affected segment, and its dependent joins. Follow [review and retry](workflow.md#review-and-retry-a-take) to regenerate a candidate step and verify the requested change.
- **Plan new footage.** [Check the project and model](workflow.md#1-select-the-project-and-model), [plan source ranges](video-segment.md), then [write Ref2VA prompts](prompt-writing.md). Keep source audio in generation references.

For new footage, [run the replacement preflight](workflow.md#publish-and-verify-the-plan) with source inspection, exact clips and saved bindings. Proceed only when it passes.

[Publish and verify the visible plan](workflow.md#publish-and-verify-the-plan) before generation. [Start the published group and review the output](workflow.md#3-start-the-group-and-review-outputs) when authorized. For a plan-only or prompt-only request, stop at that deliverable. Read [failure lessons](pitfall.md) when diagnosing a regression or deciding whether to retry.
