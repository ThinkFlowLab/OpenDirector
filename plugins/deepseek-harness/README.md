# OpenDirector for DeepSeek Harness

[中文](README.zh-CN.md)

Create media from a DSH conversation, follow generation progress, and open the same project in OpenDirector to keep editing. Generated files, editable generation settings, references, and candidate results stay together in the OpenDirector project.

## Install and connect

Use DSH **0.2.2-rc.1** with Node.js **24.9.0 or newer** and `pnpm` on `PATH`. Start OpenDirector using the [installation guide](../../docs/guides/installation.md). From this plugin directory, package it and create a Web profile before adding the bundle:

```sh
npm pack
dsh --profile studio --from-default-profile web --dump-config
dsh plugin --profile studio add ./opendirector-dsh-plugin-0.1.0.tgz
dsh --profile studio
```

Open the full DSH Web address printed at startup, then choose a workspace and a configured DSH conversation model. Initializing from `web` supplies the chat interface. For an existing Web profile, just run the `plugin ... add` command with its name. Tarball installation, Web chat, and the canvas handoff were verified with DSH 0.2.2-rc.1.

The default OpenDirector connection is `http://127.0.0.1:8000`, so a normal local installation needs no extra configuration. The plugin row is named `opendirector`. DSH calls its eight native tools as part of its own agent loop.

For development, install this checkout's dependencies before linking it into an existing profile:

```sh
npm install
dsh plugin --profile studio add /absolute/path/to/OpenDirector/plugins/deepseek-harness
```

The bundle ships ready-to-run JavaScript and needs no build. Tarball installation installs its dependencies; a linked checkout keeps its own `node_modules`. Neither route requires an npm release or a marketplace listing.

## Try a complete workflow

In OpenDirector, configure an image model under **Settings → Model connections** first. The [user guide](../../docs/guides/user-guide.md) explains model connections. The example uses that configured service.

In DSH Web, choose **Create media** in the composer and describe what you want:

> Create a project called “Moonlit studio”. Use one of my configured image models to make a cinematic moonlit room. Show me the candidate before adopting it.

1. DSH uses `opendirector_projects` and `opendirector_project` to create the project and find its image model. It saves a node with `opendirector_create_generation`, submits it with `opendirector_submit`, then checks the job ID with `opendirector_job`.
2. Once the job succeeds, inspect the saved candidate right in DSH Web. You can also open the project link and find the candidate under **Generation history**. Close the canvas tab before asking DSH to write to the project.
3. Choose **Adopt** on the candidate card. The action prepares a draft in the same DSH conversation. Review and send it. DSH reads the current revisions and calls `opendirector_adopt_result`.
4. Follow the `/ai-canvas/<projectId>` link back to the same project. Double-click the image node's title, rename it, and reopen the project to check that the new name and the selected image are still there.

To revise an image, choose **Edit** on its result card. Describe the change on the card and choose **Send request**. Use a model that accepts reference images. DSH uses `sourceResultId` to pin the exact saved image, then creates a separate generation node in the same project. The result card shows the source and candidate together. Both remain available on the canvas. Card actions preserve your current draft and attachments.

### Continue a video

With a configured MiniMax-H3 vLLM-Omni connection, choose **Animate** on an image result, describe the shot on the card, and send the request. Once the clip is ready, play it in the result card. Choose **Continue** and describe what should happen next. DSH shows the source clip and the continuation together before you decide whether to adopt the new candidate.

The first job uses `videoMode: first_frame` with the saved image's `sourceResultId`. The next uses `videoMode: continuation` with the saved clip's result ID. The configured backend must still hold that clip's continuation cache. If the cache has expired, DSH shows the job's recovery guidance. Regenerate the source on that backend or choose first-frame or reference mode. Both the existing clip and the failed attempt's inputs stay in the project.

## Configuration

For a separate API address, a Vite frontend, or Chinese tool text, override the row in the profile’s `cordis.patch.yml` or a `--patch` file:

```yaml
- id: opendirector
  config:
    baseUrl: http://127.0.0.1:8000
    canvasBaseUrl: http://127.0.0.1:5173
    locale: en-US
    requestTimeoutMs: 30000
```

A row override replaces its entire `config`. Loading the plugin validates this configuration without contacting OpenDirector.

| Setting | Default | Purpose |
| --- | --- | --- |
| `baseUrl` | `http://127.0.0.1:8000` | OpenDirector API address; HTTP or HTTPS, without credentials, query, or fragment. |
| `canvasBaseUrl` | same as `baseUrl` | OpenDirector frontend address; project links are appended here. |
| `locale` | `en-US` | `en-US` or `zh-CN` for tool descriptions, summaries, and errors. |
| `requestTimeoutMs` | `30000` | Timeout for one request. Media headers and each pending body read have a timeout capped at five seconds. A timeout does not cancel an accepted generation job. |

## Enable, disable, and remove

Disable the plugin with this profile override:

```yaml
- id: opendirector
  disabled: true
```

Set `disabled: false` to enable it again. Live profiles apply the change when they reload; profiles without hot reload need a restart. To uninstall:

```sh
dsh plugin --profile <profile> remove @opendirector/dsh-plugin
```

Accepted OpenDirector jobs keep running when the DSH plugin is disabled or an agent stops waiting. Re-enable it and use `opendirector_job` to read their saved results.

## Native tools

| Tool | Example request in DSH | What to expect |
| --- | --- | --- |
| `opendirector_projects` | “List my projects” or “Create a project called Moonlit studio.” | Project list or create receipt. |
| `opendirector_project` | “Show Moonlit studio and its configured image models.” | Project, model catalog, current object revisions, and project link. |
| `opendirector_create_generation` | “Set up an image node for a moonlit room. Wait before generating.” | Editable node and its saved references. |
| `opendirector_submit` | “Run that image generation.” | Accepted job ID with `candidate_only` selection policy. |
| `opendirector_job` | “Check the job and show me the saved candidates.” | Job state, candidates, and selection state. |
| `opendirector_adopt_result` | “Use the candidate I just reviewed as the canvas result.” | Selection receipt, using current spec and canvas revisions. |
| `opendirector_cancel` | “Cancel this generation and check whether it stopped.” | Cancellation request using the current job revision, then confirmation from a job query. |
| `opendirector_operation` | “The write timed out. Check its operation ID before retrying.” | Existing write receipt, if available. |

Read spec and canvas revisions from `opendirector_project` and the job revision from `opendirector_job`. `expectedCanvasVersions` contains `{id, revision}` entries for canvas items bound to the target spec. On a revision conflict, reread the project and review the intervening edit before retrying.

Each modifying call takes an explicit UUID `operationId`. Creating a project also takes an explicit UUID `projectId`. Replaying the exact same input preserves its IDs and versions; changing the input requires a new operation after resolving the previous outcome. Child IDs are derived from the operation with UUIDv5.

## Editing and task ownership

Queries work without an edit lease. A write briefly opens its own OpenDirector session, renews it while needed, and releases only that session. If another window owns the project, the tool reports `storage_busy`; save and close that project window before handing editing over to DSH. Read-only queries remain available.

If a write loses its response, its error includes the original `operationId` and the `opendirector_operation` lookup. Check that receipt and the project before deciding whether to replay. An absent receipt alone does not prove that the original request was never accepted.

If DSH cannot reach OpenDirector, check `baseUrl` and that the server is running. If the job itself fails, read its failure details with `opendirector_job` and correct the configured model, credentials, or input in OpenDirector as indicated. The generation node and previous selection remain available.

Cancellation is an explicit `opendirector_cancel` action. Aborting a tool request or unloading the plugin stops local waiting and never sends `job.cancel`. OpenDirector owns accepted generation jobs, provider cancellation, files, and project history; DSH owns the conversation and planning.

## Results and presentation

Tools return canonical JSON for programmatic use. Submission, progress, candidate selection, and cancellation render short localized summaries with the project name, useful IDs, next step, and project link. A full project/model read is available when the agent needs it.

DSH Web shows saved images and videos on result cards in the current interface language. Editing and continuation can be sent from the card. **Adopt** prepares a draft for you to review before sending. Once it succeeds, the receipt has a direct link to the editable canvas.

## Development checks

```sh
npm ci
npm test
npm pack --dry-run
```

Client tests use an injected HTTP transport. The host test loads the plugin with the real Cordis Loader, DSH tools, and Native executor against an isolated HTTP fixture; it covers nullable results, English/Chinese summaries, disable, and re-enable. These checks do not call a real model provider.

To also exercise the real OpenDirector project API, start the existing image-provider fixture from the repository root in a second terminal (with OpenDirector's Python dependencies installed):

```sh
PYTHONPATH=packages/core/src:apps/api/src python tests/browser/creation_server.py --port 8019
```

Then, from this package directory after `npm install`, run:

```sh
node test/creation.integration.mjs
```

This checks project creation, a saved PNG candidate, result selection and replay, edit-session conflicts, and an accepted job completing while the plugin is disabled. It requires the fixture's health marker before writing. `OPENDIRECTOR_FIXTURE_URL` can select another fixture port; the test uses generated fixture images rather than a model service.

The package pins its DSH compatibility to `0.2.2-rc.1`; DSH is in developer preview, so check compatibility before upgrading the host. OpenDirector’s own installation requirements are maintained in its installation guide.
