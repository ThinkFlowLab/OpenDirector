# Generate videos with Kling 4.0 and Flash

[中文](kling-video.zh-CN.md)

## Connect your account

1. Create an API Key in the Kling developer console. Your account must have access to the selected Kling model and sufficient API balance or resource units.
2. Open **Settings → Model connections → Video → Add service**.
3. Select **Kling official video**. Keep `https://api-beijing.klingai.com` for the Beijing service, or enter `https://api-singapore.klingai.com` for your international account. Changing the interface language does not change this address.
4. Enter your API Key and enable `kling-4.0`, `kling-4.0-flash`, or both.
5. Save the service. Select Kling explicitly in the generation model picker when you want to use it. Adding the service preserves your existing model selection.

The supported model list and output specifications are built-in declarations. Loading them does not validate your key or submit a paid task.

## Choose the input

- For text-to-video, enter a prompt without image inputs.
- For first-frame generation, select the first/last-frame mode and fill the first-frame slot.
- For first-and-last-frame generation, choose `kling-4.0` and fill both slots. Flash supports only a first frame. Frame inputs determine the output aspect ratio.
- For image references, select reference mode and attach images. These images guide content or style; they are not first-frame declarations.

Use JPEG or PNG images up to 30 MB each. Both dimensions must be at least 300 pixels, with an aspect ratio between 2:5 and 5:2. Image reference mode accepts up to ten images, subject to the encoded request-size limit. Frame mode accepts one first frame. Only `kling-4.0` also accepts one optional last frame.

Select output specifications supported by the model:

| Model | Resolution | Integer duration | Frame inputs |
| --- | --- | --- | --- |
| `kling-4.0` | 720P or 1080P | 3–30 seconds | First frame, optional last frame |
| `kling-4.0-flash` | 720P | 3–20 seconds | First frame only |

OpenDirector defaults to five seconds for both models and uses native audio. Video references, middle frames, remote Elements, voice references, and preserving an input video's audio are outside this integration's supported inputs.

## Inspect and recover results

Follow task progress in the project. Completed video files are downloaded, checked, and registered as project assets and result candidates. Adoption follows the existing version and lock checks; a completed job does not overwrite newer edits.

Generated files currently have a 50 MB download and recovery-cache limit. An oversized output cannot be saved even if Kling generated it successfully. If a download fails, recover the original task rather than creating another generation.

A submission timeout can leave acceptance unknown. Check the existing task before submitting again. Local cancellation does not confirm remote cancellation or a refund.

## Official API references

The adapter submits to the current API family without a `/v1` prefix and uses Bearer API Key authentication. It selects one submission endpoint before execution and records that choice with the job. All three paths share task querying and project result handling.

- [Text-to-video](https://klingai.com/document-api/api/video/4-0/text-to-video).
- [Image-to-video](https://klingai.com/document-api/api/video/4-0/image-to-video).
- [Omni reference-to-video](https://klingai.com/document-api/api/video/4-0/video-omni).
- [Flash text-to-video](https://klingai.com/document-api/api/video/4-0-flash/text-to-video).
- [Flash image-to-video](https://klingai.com/document-api/api/video/4-0-flash/image-to-video).
- [Flash omni reference-to-video](https://klingai.com/document-api/api/video/4-0-flash/video-omni).
- [Error codes](https://klingai.com/document-api/api/get-started/error-codes).
