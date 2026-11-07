# OpenDirector for DeepSeek Harness

[中文](README.zh-CN.md)

Create media from a DSH conversation, follow generation progress, and open the same project in OpenDirector to keep editing. Generated files, editable generation settings, references, and candidate results stay together in the OpenDirector project.

## Install and connect

Use DSH **0.2.2-rc.1** with Node.js **24.9.0 or newer**. Start OpenDirector using the [installation guide](../../docs/guides/installation.md). From this plugin directory, package it and create a Web profile before adding the bundle:

```sh
npm pack
dsh --profile studio --from-default-profile web --dump-config
dsh plugin --profile studio add ./opendirector-dsh-plugin-0.1.0.tgz
dsh --profile studio
```

Open the DSH Web address printed at startup. Initializing from `web` supplies the chat interface; adding a bundle to a completely new profile alone creates only a base composition. For an existing Web profile, just run the `plugin ... add` command with its name.

The default OpenDirector connection is `http://127.0.0.1:8000`, so a normal local installation needs no extra configuration. The plugin row is named `opendirector`. DSH calls its eight native tools as part of its own agent loop.

For development, install this checkout's dependencies before linking it into an existing profile:

```sh
npm install
dsh plugin --profile studio add /absolute/path/to/OpenDirector/plugins/deepseek-harness
```

The bundle ships ready-to-run JavaScript and needs no build. Tarball installation installs its dependencies; a linked checkout keeps its own `node_modules`. Neither route requires an npm release or a marketplace listing.

## Try a complete workflow

In OpenDirector, configure an image model under **Settings → Model connections** first. The [user guide](../../docs/guides/user-guide.md) explains model connections. The example uses that configured service.

Ask DSH:

> Create an OpenDirector project called “Moonlit studio”. Use one of my configured image models to make a cinematic moonlit room. Show me the candidate and its status first, then give me the link to continue editing in OpenDirector.

DSH can discover projects and configured models, create a visible generation node, submit it, and query the accepted job. A completed candidate is already saved in the project; selecting it as the current canvas result is a separate `opendirector_adopt_result` call. This lets you inspect a candidate before replacing your current result.

Every project-specific result includes a link to `/ai-canvas/<projectId>`. Open that link to change the prompt, inspect references, select a candidate, or continue editing the same project.

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
| `requestTimeoutMs` | `30000` | Timeout for one request. A timeout does not cancel an accepted generation job. |

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

| Tool | What it does |
| --- | --- |
| `opendirector_projects` | List projects or create one with a name, `projectId`, and `operationId`. |
| `opendirector_project` | Read the project, configured models, current object revisions, and project link. |
| `opendirector_create_generation` | Save an editable text/image/video/audio generation node and references at an explicit canvas position. |
| `opendirector_submit` | Submit a generation with `candidate_only`, returning its accepted `jobIds`. |
| `opendirector_job` | Read status, registered candidates, and whether a result is currently selected. |
| `opendirector_adopt_result` | Select an existing candidate using `expectedSpecRevision` and the corresponding `expectedCanvasVersions`. |
| `opendirector_cancel` | Request cancellation using the current `expectedJobRevision`; check the job for confirmation. |
| `opendirector_operation` | Look up a committed receipt by `operationId` after a lost or uncertain response. |

Read revisions from `opendirector_project` or `opendirector_job`. `expectedCanvasVersions` contains `{id, revision}` entries for canvas items bound to the target spec. The server checks versions and locks; the plugin never refreshes a version silently to override an intervening edit.

Each modifying call takes an explicit UUID `operationId`. Creating a project also takes an explicit UUID `projectId`. Replaying the exact same input preserves its IDs and versions; changing the input requires a new operation after resolving the previous outcome. Child IDs are derived from the operation with UUIDv5.

## Editing and task ownership

Queries work without an edit lease. A write briefly opens its own OpenDirector session, renews it while needed, and releases only that session. If another window owns the project, the tool reports `storage_busy`; save and close that project window before handing editing over to DSH. Read-only queries remain available.

If a write loses its response, its error includes the original `operationId` and the `opendirector_operation` lookup. Check that receipt and the project before deciding whether to replay. An absent receipt alone does not prove that the original request was never accepted.

Cancellation is an explicit `opendirector_cancel` action. Aborting a tool request or unloading the plugin stops local waiting and never sends `job.cancel`. OpenDirector owns accepted generation jobs, provider cancellation, files, and project history; DSH owns the conversation and planning.

## Results and presentation

Tools return canonical JSON for programmatic use. Submission, progress, candidate selection, and cancellation render short localized summaries with the project name, useful IDs, next step, and project link. A full project/model read is available when the agent needs it.

The bundle contributes native tools. The built-in DSH Web Client uses its generic tool presentation; this package does not ship a custom Web card or embedded canvas.

## Development checks

```sh
npm install
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
