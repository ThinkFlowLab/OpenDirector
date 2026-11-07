# UI Performance Design

Design for the time between a user action and the point when they can continue working. Define both the first visible feedback and the usable result for each core workflow.

## Design principles

- **Keep direct manipulation responsive.** Update typing, selection, dragging, panning, and scrubbing on the next available frame. Keep synchronous I/O and expensive work out of input handlers. Coalesce transient updates and persist edits at meaningful boundaries.
- **Keep navigation focused.** Load the data needed for the destination to become usable. Defer previews, secondary panels, and capability discovery until needed. Reuse valid results, combine duplicate requests, and cancel view-specific work when the view changes.
- **Protect foreground actions.** Limit background concurrency so discovery, polling, and media loading leave capacity for navigation and edits. Preserve focus, selection, and drafts across background updates.
- **Show meaningful progress.** Acknowledge actions promptly. For work that takes around a second or longer, show the current stage and keep unrelated controls usable. Offer cancellation when the operation supports it.
- **Preserve correctness.** Measure readiness after required state is loaded and controls are actionable. Keep save, conflict, and task status tied to authoritative receipts.

## Interaction budgets

Use these default budgets for routine UI actions such as opening a panel, navigating between loaded views, or applying a lightweight edit.

| Metric | Budget |
| --- | --- |
| User action to first visible feedback | P90 ≤ 100 ms |
| User action to usable result | Median ≤ 500 ms and P90 ≤ 1,000 ms |

Start both timers at the user action. Define the visible feedback and the usable result for each workflow, and calculate P90 using the nearest-rank method. For long-running operations such as generation or export, apply the feedback budget to acknowledging the action and measure completion separately against a workload-specific target.

## Measurement

Use browser measurements for user-facing latency. Record first feedback and readiness separately, and split slow paths into client work, request queueing, server time, and rendering. Use comparable builds, fixtures, and interaction sequences. Keep initial load, warm navigation, direct manipulation, and long-running operations separate when setting budgets and reporting results.


## Measurement example: Warm canvas switching

Measure with a production build and an isolated creation API on the same machine. Open two saved, empty projects in one browser tab and collapse the assistant. Alternate between projects using the canvas project picker. Discard two warm-up switches and record ten measured switches.

Start both timers at the click on the destination project. Feedback is the first frame that shows the switching state or the destination canvas. The destination is ready when its title and saved state are visible and the project picker is actionable.

Record the commit, environment, fixture, and per-switch measurements. Compare revisions under the same conditions. Report cold opens, unsaved edits, and media-heavy projects separately. See the [validation guide](validation.md) for isolated browser setup.
