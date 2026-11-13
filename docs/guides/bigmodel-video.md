# BigModel CogVideoX-3

[中文](bigmodel-video.zh-CN.md)

In Settings → Models, add **Zhipu BigModel video**, enter your BigModel API key, and select `cogvideox-3`. The native endpoint is `https://open.bigmodel.cn/api/paas/v4`, with Bearer authentication and the `bigmodel_video` protocol. Saving or fetching this model's built-in capabilities does not generate a video. Your account needs model access and sufficient balance; generation is billed by BigModel.

Create a video node and select the configured model. Choose an exact pixel size: `1280x720`, `720x1280`, `1024x1024`, `1920x1080`, `1080x1920`, `2048x1080`, or `3840x2160`. Duration is 5 or 10 seconds. Aspect ratio follows the selected size, so leave the separate ratio control on Auto. The adapter uses speed quality and 30 fps, and sends the chosen audio and watermark settings explicitly. Submitted jobs freeze these settings and their image inputs.

With **Remove watermark** off, the adapter sends `watermark_enabled=true`; with it on, it sends `false`. BigModel requires a signed waiver before an account can remove watermarks: complete it in **Personal Center → Security Management → Watermark Removal Management**. When BigModel is selected and Remove watermark is on, a note above Generate explains this requirement. The setting requests removal; outputs may still contain watermarks if the account does not meet the provider requirement. Provider output is preserved without local watermark removal.

The same commands serve canvas actions and Agent tools:

- **Text to video:** enter a prompt with no selected frames.
- **Single image:** import a PNG or JPEG into the project and assign it to the first-frame slot.
- **First and last frames:** import both images and assign their roles explicitly. The request sends the first frame before the last frame, regardless of reference creation order.

Images are read from project assets and sent as base64 data URIs; no public upload is required. Each image must be a valid PNG or JPEG of at most 5 MB. The complete prompt, including transmitted text references, must fit within 512 characters. Video references, continuation, and multi-image reference mode are unsupported. Ordinary connected images that are not selected as frames remain context only under the shared first-frame rules.

The adapter submits once to `/videos/generations`, saves the remote task ID, and polls `/async-result/{id}`. After restart, polling resumes with that ID. A timeout before receiving an ID leaves an unknown submission for review; it never automatically submits a replacement. Query or download recovery also uses the original task. BigModel remote cancellation is not integrated: stopping local work does not guarantee that remote generation or billing stops.

A completed video is downloaded into the project, probed, and registered as a candidate. Inspect and play it, then explicitly adopt it to change the node's current result. Reopening the project keeps the local video, candidate history, execution inputs, and adoption. Transient signed download URLs and API keys are not stored in public project snapshots.

Protocol tests use mocked HTTP and real image/video bytes:

```sh
.venv/bin/python -m pytest tests/test_bigmodel_video.py -q
node --test tests/providerPresets.test.ts
```

These checks do not prove account access or creative quality. Real-service evidence is recorded separately in the pull request.

Official references: [generation API](https://docs.bigmodel.cn/api-reference/模型-api/视频生成异步), [result query](https://docs.bigmodel.cn/api-reference/模型-api/查询异步结果), [model guide](https://docs.bigmodel.cn/cn/guide/models/video-generation/cogvideox-3), and [pricing](https://docs.bigmodel.cn/cn/guide/start/pricing).
