# OpenDirector for DeepSeek Harness

[中文](README.zh-CN.md)

Create media from a DSH conversation, follow generation progress, and open the same project in OpenDirector to keep editing. Generated files, editable generation settings, references, and candidate results stay together in the OpenDirector project.

## Install and connect

Use DSH **0.2.2-rc.1, rc.2 or rc.3** with Node.js **24.9.0 or newer** and `pnpm` on `PATH`. Start OpenDirector using the [installation guide](https://github.com/ThinkFlowLab/OpenDirector/blob/main/docs/guides/installation.md). From this plugin directory, package it and create a Web profile before adding the bundle:

```sh
npm pack
dsh --profile studio --from-default-profile web --dump-config
dsh plugin --profile studio add ./opendirector-dsh-plugin-0.1.0.tgz
dsh --profile studio
```

Open the full DSH Web address printed at startup, then choose a workspace and a configured DSH conversation model. Initializing from `web` supplies the chat interface. For an existing Web profile, just run the `plugin ... add` command with its name. Tarball installation, Web chat, and the canvas handoff were verified with DSH 0.2.2-rc.1.

The default OpenDirector connection is `http://127.0.0.1:8000`, so a normal local installation needs no extra configuration. The plugin row is named `opendirector`. DSH calls its native tools as part of its own agent loop.

For development, install this checkout's dependencies before linking it into an existing profile:

```sh
npm install
dsh plugin --profile studio add /absolute/path/to/OpenDirector/plugins/deepseek-harness
```

The bundle ships ready-to-run JavaScript and needs no build. Tarball installation installs its dependencies; a linked checkout keeps its own `node_modules`. Neither route requires an npm release or a marketplace listing.

## Find and install the plugin

The package name is `@opendirector/dsh-plugin`. In DSH’s plugin manager it appears as **OpenDirector**, with a localized description and icon. This checkout provides source and an installable `.tgz`; a registry package or a plugin-index listing is a separate publication step. Until a package is published, install from a local path or a tarball rather than entering the bare package name. Once a PR’s **DSH plugin checks** run succeeds, its Linux job uploads an installable bundle and SHA-256 file under **Artifacts**, retained for seven days.

In DSH rc.3, **Plugins → Experimental plugins → Custom plugin indexes** adds a **Discover** tab. It lists the index sources the user adds; installing a local plugin does not list it for everyone. An index entry can point to a published npm version or an exact Git commit and package directory. A release tarball remains a direct installation option. [DSH custom plugin indexes](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.3/packages/experimental/plugin-market-bundle/README.md)

Use the same installation source to update a local tarball or linked checkout. Registry-installed bundles can use DSH’s compatible-version update controls after publication; the plugin leaves installation and updates to DSH.


### Desktop installation

For Desktop, open **Plugins → Add plugin**, enter a local tarball such as `file:E:/Downloads/opendirector-dsh-plugin-0.1.0.tgz`, and enable OpenDirector. For the default address, run OpenDirector on the computer running DSH.

Beyond npm and an index, a versioned GitHub Release can carry the tarball and checksum as a stable download. Workflow artifacts are useful for trying a PR; release assets are better for a documented version. Link the setup guide and a short generation-to-adoption demo from the project README and any community listing.

### Check the connection

Choose the plug icon (**Connection check**) next to **Action packs**. The dialog shows the configured API and canvas addresses, project count, and model connections for images, references, image-to-video, continuation and voiceover. It checks once when opened; use **Check again** after changing the service.

An empty model catalog links you to OpenDirector to configure one. Connection errors explain whether to check the address, start the service, or fix access. **Copy diagnostics** copies the plugin version, addresses, status and counts; it omits project names, model credentials and provider responses. Listed models have not been tested by a generation. This check makes no model calls.

## Platform coverage

The interactive workflow has been verified in DSH Web with the host running in WSL Ubuntu. Native Windows checks cover plugin loading, tool execution and HTTP routes. The plugin workflow includes Linux, Windows and macOS jobs. DSH Desktop still needs an end-to-end installation and media check.

## Continue with fewer repeated choices

On this device, the plugin remembers the last project, project-list view and model settings for each creation action, separately for each OpenDirector service. New forms reuse models that are still available and keep the last image size or video duration. For continuation, choose the connection that generated the source clip. An unsubmitted draft takes priority. A fresh creation starts with one candidate; a saved draft keeps the count you chose. Clear these preferences under **Connection check → Diagnostic text → Forget recent settings**.

Image cards keep **Adopt**, **Edit** and **More actions** in view. **Animate**, **Reuse settings**, download and action packs remain in the menu. Video cards keep continuation handy, and voiceover cards offer reuse.

Each node's results show V1, V2 and so on in registration order, unchanged by search or pagination. Cards also show the job time and an identified source version when available. An edit creates a separate node, so its numbering starts at V1 and can point back to the source node's version.

If a project list or model catalog cannot be loaded, reload it in the same dialog. After adding a model in OpenDirector, reload an empty catalog to continue. Your description, action names and chosen reference stay in place; reloading only reads data.

If a preview fails to load, choose **Reload preview** on the same card. The original-image viewer also offers a reload button.

## Examples and a short demo

Open **Try an example** in a creation form to start with a studio image, character reference, product cover or voiceover. Saved-image actions offer examples for edits and motion; continuation has its own example. Read the description, then choose **Use this description** or **Replace current description**. Your model, image size, reference order and candidate count stay as selected. Filling an example does not generate media.

Action packs offer **Example actions** for a desktop companion or a set of expressions. **Replace action list** fills three editable actions while keeping the reference image, shared description and model.

See the [workflow demo and example scenarios](https://github.com/ThinkFlowLab/OpenDirector/blob/main/plugins/deepseek-harness/docs/showcase.md). To prepare a versioned tarball, checksum, Release notes and a custom plugin index together, follow the [release guide](https://github.com/ThinkFlowLab/OpenDirector/blob/main/plugins/deepseek-harness/RELEASING.md).

## Try a complete workflow

In OpenDirector, configure an image model under **Settings → Model connections** first. The [user guide](https://github.com/ThinkFlowLab/OpenDirector/blob/main/docs/guides/user-guide.md) explains model connections. The example uses that configured service.

In DSH Web, choose **Create media** next to the composer. Select an existing project or name a new one. Choose a model, enter your prompt, and click **Generate one candidate**. You can also choose **Voiceover**, enter the text, and listen to the result in DSH.

Choose **Number of candidates** (1–4) to create a group in one action. Each candidate is a separate generation task on the same node. The group shows saved progress and completed media together; select two images to compare, then adopt the version you prefer. Groups also work with voiceover and video forms. A failed member keeps its error while successful siblings remain available.

When a group submission is unconfirmed, check its original receipts. **Continue the original group** explicitly submits any remaining members with their original operation IDs. It keeps accepted jobs and stops if the source node’s settings have changed. Saved task history reopens the whole group after reloading DSH.

After a submission is accepted, **Generation settings** folds away so the candidates stay in view. Expand it to inspect the submitted settings. The plugin follows DSH’s light and dark themes, with distinct generation, adoption and current-result controls.

Unsubmitted input stays in the current browser tab. Close the dialog or reload DSH, then return to the same creation or edit action to continue. This includes the chosen model, image size and ordered references. Use **Clear draft** to start over. Submitted jobs stay in **Resume project → Tasks**; reopening a draft does not submit it.

If a submission is unconfirmed, reopen the action or choose **Resume project → Submissions to check** after closing or reloading DSH. Checking uses the original submission ID and opens the accepted task without generating again; it does not require the model catalog. **Start a separate creation** opens a new form and keeps the original submission available to check. **Hide reminder** only removes the local reminder. Recovery information stays in the current browser tab. If browser storage is unavailable, keep the page open and check before reloading.

If you choose an image size and then change models, the form keeps your choice when the new model supports it. If that size is unavailable, choose a different size or model before generating.

In **Resume project**, search descriptions, canvas node names, models or copied IDs across the whole project. Search checks the full recorded description, including text beyond the card preview. Results, tasks and reference choices show one page at a time; use Previous page and Next page to browse without keeping every card mounted. Selected comparison images and references stay selected when you change pages. Combine it with media and adoption filters, or filter tasks by their current status. **Clear search and filters** returns to the full list.

Choose **Compare images** in **Resume project**, select two saved images, and open the comparison. Selections can come from different filtered pages of the same project. Original images load only when you open the comparison. You can inspect them at a larger size and adopt either result; each node keeps its own current-result selection.

Automatic task checks pause while the page is hidden or offline. Returning to the page or reconnecting checks the same task. This does not stop the generation job. Media players show a buffering message while waiting for content.

To change a saved image or voiceover, choose **Reuse settings** on its result card. The form starts from that version’s recorded prompt and parameters. Images can keep their original size or use another listed size. The model, voice identity and references stay fixed; other saved parameters are retained. Generation creates a new node in the same project, ready to review before adoption. Structured prompt documents and expanded subject references can be adjusted on the canvas.

Choose **Generate another candidate** to run the same canvas node again with its saved settings. Compare the results in the dialog and choose **Adopt** on the one you want to use.

Cards show the file's actual dimensions and duration when available. Click an image to view the original in DSH, then switch between **Actual size** and **Fit to window**.

If you lose the connection, use **Check submission** or **Check progress** to look up the same operation. If the provider confirms a quota or rate limit failure, fix the issue and choose **Retry generation** to use the same node. When a canvas holds the project open, save and close it, then try again in the same dialog.

For an open-ended request, use the chat as usual:

> Create a project called “Moonlit studio”. Use one of my configured image models to make a cinematic moonlit room. Show me the candidate before adopting it.

1. DSH uses `opendirector_projects` and `opendirector_project` to create the project and find its image model. It saves a node with `opendirector_create_generation`, submits it with `opendirector_submit`, then checks the job ID with `opendirector_job`.
2. Once the job succeeds, inspect the saved candidate right in DSH Web. You can also open the project link and find the candidate under **Generation history**. Close the canvas tab before asking DSH to write to the project.
3. Choose **Adopt** on the candidate card. The plugin reads the current revisions, selects the result, and shows a link to the canvas.
4. Follow the `/ai-canvas/<projectId>` link back to the same project. Double-click the image node's title, rename it, and reopen the project to check that the new name and the selected image are still there.

To revise an image, choose **Edit** on its result card. Pick a model that accepts reference images, describe the change, and click **Generate one candidate**. The plugin pins the saved image and creates a separate generation node in the same project. You can compare the source and the new result before adopting it. These forms preserve your chat draft and submit directly to OpenDirector.

If the model accepts multiple references, choose **Add reference images** to pick other saved images from the same project. The source stays first. Use the arrows to change the order of the other references.

If the submission reply is lost, choose **Check submission** to look up the original operation. For a job that failed after submission, open the canvas to inspect the saved generation settings and the failure details.

### Pick up an earlier project

Choose **Resume project** next to the composer, then select an OpenDirector project. Filter the saved results by media type or current selection, sort by when they were saved, and choose **Load more** for the next page. If a canvas is open for editing, save and close it before trying to adopt a result. If the connection drops during adoption, choose **Check adoption** to look up the original write.

Choose **Tasks** to find running, completed, and failed generations, including work submitted before you refreshed DSH. Filter by media type or change the order to find an earlier task. **View progress** opens that saved task. Completed candidates can be previewed and adopted there. A confirmed retryable failure offers **Retry generation** on the existing node. Closing the dialog keeps the task available in this list.

Right-click a result card or choose **More actions** on it. The menu shows the actions for that media type, including downloading the original file. Use the arrow keys to move between actions, and press Escape to return to the card.

In task progress, choose **Request stop** to ask OpenDirector to stop the job. Closing the dialog leaves the job running. If the response is lost, **Check stop request** reads the original operation. The dialog distinguishes stopped local processing from confirmed provider cancellation.

### Animate an image or continue a clip

Choose **Animate** on a saved image. The form shows that image as the first frame and lists the video models that support it. Pick a model, choose a duration from its available options, and describe the motion. Generate one candidate and play it in DSH before adopting it.

For a clip generated by a compatible MiniMax-H3 vLLM-Omni connection, choose **Continue**. Select the same connection, choose the duration of the next shot, and describe what happens next. Play the source and candidate in the same form. The service uses its cached state for that clip. If the cache has expired, generate the source clip again on that connection. The clip and the continuation settings are saved in the project.

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

DSH Web shows saved images, videos, and audio on result cards in the current interface language. Open the creation forms directly from a card. **Adopt** selects the result and links back to the canvas.

## Character action packs

From a saved image, open **More actions → Make an action pack**. Name 1–6 actions, add a shared character description, and choose an image model accepting references or a first-frame video model. **Create and generate** sends one task per action. Each action keeps its own candidates and adoption; generating another version leaves the current choice in place. Use **Adjust action** to change one action’s description and generate a new version while keeping other actions and existing choices.

Choose **Action packs** next to the composer to reopen a saved pack. Pick one version for every action, then **Download action pack**. The ZIP contains numbered media files and a manifest with the selected results, descriptions, model IDs and content fingerprints. Downloads stream directly from project assets, up to 128 MB, without making a second local copy.

The reference image is pinned for every action. Character consistency, motion quality, transparency and loop timing depend on the model and the prompt; inspect the actual output before using it in a desktop pet. The pack exports individual images or clips, rather than an installed pet or a sprite-sheet runtime.

In conversation, use `opendirector_action_pack` to list, read, prepare, generate or check a pack. Preparing saves its nodes without calling a model. Generating requires explicit action item IDs and keeps the results as candidates. For a lost response, check the original operation ID and continue the same submission. Use `revise` with `itemId`, `prompt` and `expectedSpecRevision` to save one action’s description without generating. Selection uses the existing adoption tool. Closing the dialog leaves accepted jobs running.

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

The package declares DSH 0.2.2-rc.1, rc.2 and rc.3. Web installation and operation have been verified on rc.1. In a full published rc.3 Web host, the packaged plugin passed image creation, action revisions, independent candidate selection, reload recovery, video playback and ZIP export. The rc.3 tool packages also passed the plugin loading and execution checks. The rc.2 tool interfaces were checked against its release source; a full rc.2 host and DSH Desktop still need hands-on acceptance. OpenDirector’s installation requirements are maintained in its installation guide.
