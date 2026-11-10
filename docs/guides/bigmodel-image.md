# Zhipu BigModel GLM-Image

## Setup

Open **Settings → Model connections → Image → Add service**, choose **Zhipu BigModel**,
and enter your BigModel API key. The preset uses `https://open.bigmodel.cn/api/paas/v4`
and `glm-image`. The account must have image API access and sufficient balance;
a coding subscription does not replace image API credit. Saving the connection
does not generate an image. Credentials stay in local model settings and are not
included in project snapshots.

## Generate and adopt

Create an image generation node, select `glm-image`, enter a prompt and choose an
offered aspect ratio and size. GLM-Image supports text-to-image only: text assets
can contribute reference text, but reference images and image editing are not
supported. Available sizes are 1280×1280, 1568×1056, 1056×1568, 1472×1088,
1088×1472, 1728×960 and 960×1728. The default is 1280×1280.

The synchronous API returns one image URL. OpenDirector downloads and decodes the
picture, stores a local PNG project asset and registers a result candidate.
The existing adoption policy applies: an unchanged node can adopt automatically;
candidate-only generation requires selecting the result. After adoption, close
and reopen the project to inspect the same local asset without calling BigModel.

The Agent uses the same model configuration, `generation.submit` command,
validation, candidate storage and `result.select` adoption operation. Configuring
the image service does not configure the conversational Agent's separate chat model.

**Remove watermark** is sent as the inverse of BigModel's `watermark_enabled`.
BigModel only permits watermark removal for accounts that have signed its disclaimer
in **Personal Center → Security Management → Watermark Removal Management**.
Without that account permission, the provider may still return a watermarked image
when removal is requested. A note above Generate explains this when removal is on.
OpenDirector preserves the original provider output and does not erase watermarks locally.
The adapter sends `model`, `prompt`, `size` and `watermark_enabled`; it does not send
OpenAI-only `n`, `response_format` or `output_format` parameters.

## Failures and recovery

Authentication, balance, rate limits and provider failures appear in generation
feedback. A submission timeout has unknown acceptance: OpenDirector does not
automatically repeat the paid generation. Once the result URL is recorded, a
download failure can resume the original download without another generation.
CDN requests contain no provider credentials; private network destinations and
redirects to them are rejected. An expired result URL may require a new explicit
generation. Project files contain the downloaded image rather than relying on
the remote URL remaining available.

Protocol and persistence checks use HTTP substitutes and real image bytes:

```sh
.venv/bin/python -m pytest tests/test_bigmodel_image.py -q
node --test tests/providerPresets.test.ts
```

These checks do not establish real account acceptance. Real validation requires
a configured account, an actual decodable generated image, adoption, project
reopening and workflow screenshots.

See the [official image API](https://docs.bigmodel.cn/api-reference/模型-api/图像生成)
and the [Chinese guide](bigmodel-image.zh-CN.md).
