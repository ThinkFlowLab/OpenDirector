# Voice library

The audio composer can browse, create, favorite, and select voices without leaving the canvas. The selected model configuration owns the connection; the browser never receives its API key.

## Provider support

| Operation | vLLM-Omni (self-hosted OpenAI-compatible audio) | MOSS (`moss-tts-1.5-flash`) |
| --- | --- | --- |
| List | `GET /v1/audio/voices`; built-in names plus uploaded entries | `GET /v1/audio/voices?limit=20&after=…`; account voices with cursor pagination |
| Create | `POST /v1/audio/voices` with `audio_sample`, `name`, `consent`, optional `ref_text` and `speaker_description` | `POST /v1/audio/voices` with `audio_sample` and optional `name` |
| Delete | `DELETE /v1/audio/voices/{name}` for uploaded voices | Hidden; the current API does not document deletion |
| Preview | No preview URL is returned; the preview button stays unavailable | No preview URL is returned; the preview button stays unavailable |

The service connection is `providerId` when the model belongs to a grouped service, otherwise the model configuration ID. A voice name or ID from one connection stays invalid in another connection even when the text is identical.

## Composer behavior

- `All voices` lists built-in and uploaded voices. `My voices` lists voices created or uploaded through the current connection. `Favorites` is stored in browser storage under the connection identity.
- Selecting a voice writes its ID to the generation settings together with the connection identity and whether the voice carries a reference transcript.
- Changing models keeps the selection only within the same connection and provider. Missing connection identity, a different provider, or a required transcript that the voice lacks clears the selection and asks for a new choice.
- `Create voice` is the first grid entry in `All voices` and `My voices`. The form shows file name, size, supported formats, the provider duration limit when known, and a local preview before upload.
- `ref_text` is optional for most vLLM-Omni models and required for the Drama3 and CosyVoice3 families. MOSS copies use the service's `audio_sample` and `name` fields.
- Uploaded vLLM-Omni voices expose a delete action. Built-in voices and MOSS voices do not.

## Local API

All routes require the normal local-app header and resolve the model configuration on the server.

```text
GET    /api/model-configs/{configId}/voices?limit=20&cursor=…
POST   /api/model-configs/{configId}/voices    multipart/form-data
DELETE /api/model-configs/{configId}/voices/{voiceId}
```

The list response contains `voices`, `hasMore`, `nextCursor`, and the provider `capabilities`. Rows contain only display data and voice identity: no API key, consent value, reference transcript, or provider response text.

## Limits and verification

The server accepts a non-empty sample of at most 10 MB. vLLM-Omni formats are `wav`, `mp3`, `flac`, `ogg`, `aac`, `webm`, and `mp4`; MOSS formats are `wav`, `mp3`, `m4a`, and `flac`. MOSS documents a 30-second maximum. vLLM-Omni documents no duration limit for this endpoint.

The tests use HTTP doubles for both providers. They verify request routes, multipart fields, pagination, authentication headers, normalization, and that credentials never appear in responses. Real provider calls, real account permissions, and provider-side deletion policy remain environment-dependent and are not claimed by those tests.
