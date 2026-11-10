# Release tags and daily cuts

Public releases are SemVer git tags plus a GitHub Release. This page is how a cut is made. Release readiness stays the go/no-go on [#7](https://github.com/ThinkFlowLab/OpenDirector/issues/7).

## Tag

Public tags are `vMAJOR.MINOR.PATCH`. Keep a single public stream. Do not add CalVer, date tags, nightly tags, or any other public tag family.

- Daily patch cuts stay on `v0.1.x`.
- Bump MINOR only for a named milestone.
- Bump MAJOR only when declaring a supported public product (`v1.0.0`).

`v0.1.0`, `v0.1.1`, and `v0.1.2` are the first tags on this line. Each published tag has a GitHub Release. In-tree version fields stay at the last cut until the next version-bump pull request lands.

A published tag is immutable and points at one `main` commit: the commit after the version-bump pull request merges. Do not retag. Do not create a floating `latest` git tag.

Ship a GitHub Release with the tag. Notes are English and list the merges since the previous tag.

## When to cut

Do not tag every merge. One cut covers that day's landed work: a version-bump pull request, then one tag.

Cut around 04:00 Asia/Shanghai, after the nightly that starts at about 02:00 Asia/Shanghai (`0 18 * * *` UTC in [`nightly.yml`](../../.github/workflows/nightly.yml)). Cut only when `main` has merges since the previous tag and both of these are green:

- [Release checks](../../.github/workflows/release-checks.yml)
- the last nightly `gate-parity` lane

Skip the cut when there are no merges, or when that gate is red or still running. The advisory nightly lanes `browser-production`, `browser-extended`, and `perf-outputs` do not block. What each nightly lane covers stays in the [validation guide](validation.md).

Nightly CI is a gate, not a public release. It does not create a tag.

## Version-bump pull request

Align the same fields as [#248](https://github.com/ThinkFlowLab/OpenDirector/pull/248) and [#204](https://github.com/ThinkFlowLab/OpenDirector/pull/204):

| Field | Where |
| --- | --- |
| npm package and lockfile | `package.json`, `package-lock.json` |
| Python distribution | `pyproject.toml` |
| Local API OpenAPI version | `apps/api/src/opendirector_api/main.py` (`FastAPI` `version`) |
| DeepSeek ACP `clientInfo` | `packages/core/src/opendirector/agent/deepseek.py` |
| Claude plugin manifest | `packages/core/src/opendirector/agent/native.py` (the `version` written into `.claude-plugin/plugin.json`) |

On every other change, leave these fields at the last cut. Tag the `main` commit after this pull request merges.

## Later installable nightlies

If installable nightlies are added later, publish them as GitHub prereleases (for example `v0.1.3-nightly.YYYYMMDD`) and keep the repository's latest release on the public SemVer tag. Prereleases stay off the public tag stream.
