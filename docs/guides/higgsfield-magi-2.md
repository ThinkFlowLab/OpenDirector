# MAGI-2 through Higgsfield Open

[中文](higgsfield-magi-2.zh-CN.md)

## Account connection

Open **Settings → Model connections → Video → Add service**, choose **Higgsfield Open**, and keep `https://api.higgsfield.ai`. Enter your Higgsfield Open credentials as `KEY_ID:KEY_SECRET`, enable `sand/magi-2`, and save. Select this model in the generation picker.

The model list and output specifications are built-in declarations. Loading or saving them does not test account access or submit a generation. Generating requires model access and sufficient API credits.

## Inputs and output

One connection supports three inputs in both the canvas and Agent:

| Input | Selection |
| --- | --- |
| Text | Enter a prompt with no media references. |
| First/last frames | Choose first/last-frame mode and select a first image, optionally a last image. |
| References | Choose reference mode and attach images, video, audio, or a mixture. A single ordinary image remains a reference. Audio may be used on its own. |

Text-to-video requires a prompt. A prompt is optional with media. The final prompt, including connected text, allows up to 15,000 characters; excessive input is rejected without truncation.

| Reference | Formats | Maximum count | Size per file | Duration |
| --- | --- | --- | --- | --- |
| Image | JPEG, PNG, WebP, GIF | 10 | Smaller than 30 MB | — |
| Video | MP4 | 5 | 200 MB | 2–30 seconds each; 30 seconds total |
| Audio | WAV | 5 | 15 MB | 2–30 seconds each; 30 seconds total |

Convert MOV to MP4 and MP3 to WAV before attaching them. OpenDirector uploads the original accepted bytes through Higgsfield's upload service. Credentials are only sent to the official API.

Output is 1080p, with an integer duration of 4–30 seconds. New nodes default to 5 seconds, 16:9 and generated audio enabled. The available ratios are 21:9, 16:9, 4:3, 1:1, 3:4 and 9:16, including for first/last frames. Generated audio can be disabled. Saved supported choices are preserved.

## Tasks and results

Accepted jobs retain their inputs and parameters. Completed files are downloaded, checked and registered as project assets and result candidates. Adoption follows existing version and lock checks, preserving newer edits. Generated files have the existing 50 MB download and recovery-cache limit.

Recover an interrupted original task to continue submission, querying, downloading or saving. The private recovery cache preserves the exact submitted body, uploaded URLs and a fixed `Idempotency-Key`, which identifies one intended generation. Replaying that request uses the same remote generation. A damaged cache stops recovery before another submission.

An unknown submission can only be replayed with the original API Key ID. If you change it, restore the original connection before recovering that task; a different account has a separate idempotency history.

Remote cancellation is available while the request is queued. A cancellation request and confirmed remote cancellation are tracked separately. If generation has started, Higgsfield rejects cancellation; stopping local work does not stop remote processing or confirm a refund.

## API references

- [Text-to-video](https://open.higgsfield.ai/models/sand/magi-2/text-to-video/api-reference)
- [Image-to-video](https://open.higgsfield.ai/models/sand/magi-2/image-to-video/api-reference)
- [Reference-to-video](https://open.higgsfield.ai/models/sand/magi-2/reference-to-video/api-reference)
- [File uploads](https://docs.higgsfield.ai/docs/concepts/file-uploads)
- [Request lifecycle](https://docs.higgsfield.ai/docs/concepts/requests)
- [Idempotent requests](https://docs.higgsfield.ai/docs/concepts/idempotency)
