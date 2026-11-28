# Case03 · H3 Agentic Continuation

> Use the prepared Case03 assets to replace the five assigned performers. Start from B, continue backward into A and forward through C → D → E. Deliver an editable timeline and MP4 in A → B → C → D → E order.
>
> **Historical baseline notice:** Case03 reproduces an approved legacy ComfyUI baseline verbatim, so it intentionally retains legacy prompts (`case03_prompts.json`), tail-frame padding (A/B/C), and windows longer than six seconds (C/D/E). **Do not imitate those exceptions for new footage.** Validate Case03 with `validate_frame_plan.py case03-frame-plan.json` (without `--enforce-window-limit`) and `check_prompt.py saved-prompts.json --expected case03_prompts.json`.

The [segment plan](case03-segment-plan.md) records the source windows, portrait order, guides and cuts. The five steps use the [original Case03 prompts](case03_prompts.json) with seed 0. The published group covers the complete 648-frame source at 24 FPS.

## Open the draft

Choose **Import canvas** and open the [Case03 draft canvas](run-h3-agentic-continuation.canvas). It includes the inputs, five generation nodes, guide connections, timeline and a draft plan. The embedded video, portraits and 27-second demo soundtrack are synthetic placeholders.

1. Replace the complete source, five prepared clips and five portraits on their existing nodes so the links remain connected.
2. Replace the demo soundtrack with the delivery track, using the original source audio when that is the intended soundtrack. The prepared reference clips retain their own source audio.
3. Note the asset IDs and the draft group ID from `opendirector project show`. Pass the group ID to the builder below with `--existing-group` to prepare and publish that group.

Publish before using the group's **Run group** action. The draft plan is a preview. The publication receipt identifies the saved plan node that belongs to the sealed group.

## Prepare and publish

Use a FastH3 Omni configuration with `inputRules.profile: fasth3-omni` and `inputRules.videoCapabilities.timelineGuides: true`. Check it with `opendirector model list --kind video`. Normalize the complete Case03 source to 648 frames at 24 FPS CFR and prepare the [five model inputs](case03-segment-plan.md#source-windows-and-identity-mapping). Reverse audio and video together for A and B before padding. Register the master, five clips, five portraits and delivery audio in the project.

| Portrait | Source performer | Steps |
| --- | --- | --- |
| `<Picture 1>` | Center performer originally in a pale suit | A, B, C, D, E |
| `<Picture 2>` | Right foreground | B, C |
| `<Picture 3>` | Left background | B, C |
| `<Picture 4>` | Left foreground | B, C |
| `<Picture 5>` | Right background | B, C |

Each request uses its own prepared clip as `<Video 1>`. The images follow the order above. A continuation guide takes two frames from the specified upstream result in that execution.

Set `CASE03_DIR` to the skill's `examples` directory. The script writes a preparation batch and a separate publication command. With no `--existing-group`, the batch creates a new Case03 group and reuses matching visible asset nodes. Set `--resolution 768P` for the standard 1344 × 768 FastH3 preset. The default 480P preset uses 832 × 480. Supply `--width` and `--height` when the deployment uses a different geometry.

```sh
opendirector project show | python3 "$CASE03_DIR/case03_canvas.py" \
  --model "$MODEL_CONFIG_ID" --master "$MASTER_ASSET_ID" \
  --source-a "$SOURCE_A_ID" --source-b "$SOURCE_B_ID" \
  --source-c "$SOURCE_C_ID" --source-d "$SOURCE_D_ID" --source-e "$SOURCE_E_ID" \
  --portrait "$PORTRAIT_1_ID" --portrait "$PORTRAIT_2_ID" --portrait "$PORTRAIT_3_ID" \
  --portrait "$PORTRAIT_4_ID" --portrait "$PORTRAIT_5_ID" \
  --soundtrack "$SOUNDTRACK_ID" --publish-file case03.publish.json > case03.batch.json &&
opendirector creation batch --file case03.batch.json &&
opendirector group publish-run --file case03.publish.json
```

For the imported draft, add `--existing-group "$GROUP_ID"` to the script command. The preparation step pins video and portrait versions, restores the exact prompts, sets seed 0 and retains the four follow-current guide edges. The publication step saves the group definition, assembly and readable plan together. Check `planItemId` in the applied receipt, then read the plan node before starting.

## Run and inspect

Select **Case03 · H3 Agentic Continuation**, then choose **Run group**, or run the commands below. Use a UUID as `START_ID` for this start and keep the returned execution ID for subsequent status checks.

```sh
opendirector --operation-id "$START_ID" group start-run --group-id "$GROUP_ID"
opendirector query run.execution.get --object-id "$RUN_EXECUTION_ID"
```

Expect five editable visual clips and 648 decoded MP4 frames at 24 FPS. Check identity continuity, action, joins and the selected delivery audio.
