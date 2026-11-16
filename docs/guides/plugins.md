# Optional creative plugins

[中文](plugins.zh-CN.md)

Plugins add optional creative Skills to the existing assistant harnesses. Open
**Settings → Plugins**, install a package, then enable the harnesses that may
use it. Every installation starts disabled. The same package can support Default,
OpenCode, Codex, Claude Code, JiuwenSwarm and DeepSeek Harness; switching harnesses
shows only the Skills enabled for that harness.

This format is an OpenDirector Skill package, with one native Skill entry and
supporting templates or scripts. It is distinct from the [DSH integration
bundle](../../plugins/deepseek-harness/README.md), which lets external DSH call
OpenDirector. Other harnesses' native plugin formats are not accepted as packages.

## Install and use

1. In **Settings → Plugins**, choose **Install Creative brief**, select a ZIP,
   or enter a local directory/ZIP path or public HTTPS ZIP URL. Paths refer to the
   computer running the backend and must stay inside its workspace. Relative paths
   start at that workspace; absolute paths inside it also work. Use a package
   folder such as `plugins/my-plugin`; the workspace root, `projects/` and
   `.opendirector/` are excluded. For packages in other locations, use
   **Choose ZIP file**. Only install packages you trust.
2. Enable the desired harness under **Enabled harnesses**. Dependencies must be
   installed at their declared versions and enabled for that same harness first.
3. Choose that harness in the assistant and open **Skills**. Select the plugin
   and describe your goal in Chinese or English. Existing model configuration and
   harness authentication still apply.
4. Inspect the resulting project assets. The official Creative brief example
   reads project context, prepares a brief and shot outline, and publishes an
   editable Markdown text asset. It does not itself request image/video generation.

The application includes only the official discovery catalog. Example payloads
are downloaded on explicit installation; source checkouts can use the matching
local example. No optional plugin is activated or added to the default Skill
catalog automatically. Installation validates files and never runs package hooks.
Once enabled, Skill instructions and scripts use the harness's existing tools,
permissions and project business commands; installation does not grant new access.

## Disable, remove and update

Changes apply to subsequent turns. Already accepted turns keep their Skill
snapshot. When the enabled package set changes, a new native session starts with
the saved conversation history instead of resuming the old plugin context.
Remove a disabled Skill from any unfinished message before sending it; the server
rejects selected Skills that are no longer available.

Disable dependent plugins first. To change a package version, disable and uninstall
the old package, install the new one, then enable its harnesses. Installing identical
contents again preserves activation; different contents with the same ID are
rejected until the previous package is removed. Dependencies use exact versions,
not ranges, and there is no automatic dependency download or update.

The registry and immutable package cache live under the backend workspace's
`.opendirector/plugins/`. They survive restarts and apply across its projects.
Uninstall removes registration and future discovery. Cached package files remain
for in-flight turns; there is no automatic cache deletion. Project assets,
generation configuration, conversation history and execution receipts remain in
the unified project and can still be edited after disabling or removing a plugin.
If a cached package is damaged, uninstall and reinstall from a valid source.
Reinstallation preserves the damaged cache under `.opendirector/plugins/.damaged-*`
before publishing the validated replacement; it does not delete the old files.

## Make a custom package

Copy [plugins/template](../../plugins/template) and change the ID, bilingual name,
description, supported runtimes and Skill instructions. Keep these identities equal:

```text
opendirector-plugin.json → id: my-creative-tool
skills/my-creative-tool/SKILL.md → name: my-creative-tool
```

The manifest requires `schemaVersion: 1`, a lowercase hyphenated ID (up to 64
characters), a `major.minor.patch` version (optional prerelease), `zh-CN` and `en-US`
names/descriptions, and one or more runtime IDs. Runtime IDs are `default`,
`opencode`, `codex`, `claude`, `jiuwenswarm`, `deepseek`. Optional `dependencies`
maps plugin IDs to exact versions, for example `{"studio-brief": "1.0.0"}`.

The Skill needs YAML frontmatter with matching `name` and a nonempty `description`.
Additional or nested `SKILL.md` files are rejected, regardless of filename case.
Keep templates and scripts under its directory: those resources are copied into
the turn's native Skill directory. Other package files are retained but are not
exposed as Skill resources. Publish outputs through the existing `opendirector`
CLI or business tools, preserving command IDs, version checks, locks and receipts.
Do not maintain a separate editable project or write the project JSON directly.

Install a directory inside the backend workspace while developing. Parent path
aliases are resolved before checking the workspace boundary. File reads pin every
path component without following links, and reject hard links. Empty resource
files are allowed. To share it, ZIP its **contents**, with
the manifest at the archive root, and use **Choose ZIP file** or a public HTTPS
download URL. A package permits up to 256 files/archive entries, 2 MiB per file,
20 MiB unpacked and 10 MiB compressed. Skill text is limited to 64 KiB. Links,
special files, encrypted archives, ambiguous or escaping paths, private network
URLs and credentials in URLs are rejected. Redirect destinations are also checked.

Official maintainers edit `packages/agent/plugin-examples/` and run
`python scripts/package-plugin-examples.py` with the project's Python dependencies
installed. Commit the resulting `plugins/catalog.json` and `plugins/examples/`
ZIP together; the catalog pins the expected package content digest.
