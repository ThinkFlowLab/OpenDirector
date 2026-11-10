## Summary

<!-- What changed and why. Keep the pull request to one concern. -->

-

## Linked issue

`Fixes #N` closes that issue when this pull request merges. `Refs #N` links the issue and leaves it open. Use `Refs` when the issue should stay open, or when auto-close intent is unclear. If no issue applies, say so.

- [ ] `Fixes #N` or `Refs #N` is included, or no issue applies

## Labels

Apply one `type:` label and at least one `area:` label. The taxonomy is in [CONTRIBUTING.md](../CONTRIBUTING.md).

- [ ] Labels applied

## Test plan

Say what you ran locally and what you left to Release checks. Name checks you could not run. Do not list a check you did not run. Commands are in [docs/development/validation.md](../docs/development/validation.md).

- Local:
- Left to CI:

## Evidence that it works

Reviewers use this to see that the change works, not only that CI is green. When the change is user-visible (UI, canvas, provider settings, generation flows, and similar), attach screenshots, a short screen recording, or a demo GIF. Otherwise mark N/A and give the reason (docs-only, pure refactor with no UI, CI-only, and similar).

- [ ] Media attached, or N/A because:

## Provider verification

Never claim real-provider verification you did not run. State what used a model double, what still needs credentials, and what remains unverified. See [CONTRIBUTING.md](../CONTRIBUTING.md).

- [ ] Real-provider calls are described honestly, or none were made

## Bilingual UI

When user-facing strings change, ship `zh-CN` and `en-US` together. See [AGENTS.md](../AGENTS.md).

- [ ] Both locales are updated, or no user-facing copy changed
