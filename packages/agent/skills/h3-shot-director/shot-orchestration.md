# Multi-Shot Orchestration, QC & Local Timeline Revision

## 1. Anti-Homogenization Shot Planning

Before creating generation nodes for a multi-shot film or reference-video remake, write a JSON shot plan in the execution directory and validate it:

```json
{
  "shots": [
    {"shotNumber": 1, "durationSeconds": 5, "mode": "i2va", "shotSize": "wide shot", "cameraMotion": "Push In", "action": "Establish rain-slicked alley and courier silhouette"},
    {"shotNumber": 2, "durationSeconds": 5, "mode": "ref2va", "shotSize": "medium close-up", "cameraMotion": "Truck Right", "action": "Courier checks glowing parcel address"},
    {"shotNumber": 3, "durationSeconds": 6, "mode": "fl2va", "shotSize": "close-up", "cameraMotion": "Tilt Up", "action": "Fingers break wax seal and lift eyes toward doorway"}
  ]
}
```

```bash
opendirector video lint-shot-plan --file ./shot-plan.json
```

Design rules for cinematic rhythm:
- Alternate spatial scale (`wide shot` -> `medium close-up` -> `close-up` or `over-the-shoulder shot`) so cuts introduce new visual information rather than micro-jumping from a nearly identical angle.
- Never repeat the exact `(shotSize, cameraMotion)` pair for 3+ consecutive shots.
- Balance moving camera shots (`Push In`, `Truck Right`, `Arc Shot`, `Tracking Shot`) with deliberate `Static Shot` beats during rapid subject motion or dialogue punchlines.

## 2. Pilot Anchor Gate Before Full Batch Submission

To avoid wasting generation time and quota on drifted character faces or mismatched lighting:
1. Prepare or generate reusable character/environment anchor assets first (or extract reference anchors when authorized).
2. On sequences of 3+ shots or commercial API models, generate and inspect the anchor keyframes or Shot 1 pilot before submitting the remaining shots, unless the user explicitly instructed full immediate execution.
3. Arrange canvas nodes on clean non-overlapping coordinates (`--x`, `--y`) read from `opendirector project show`, grouping anchor assets to the left and sequential shot nodes left-to-right.

## 3. Compiling & Verifying H3 Prompts via CLI

Compile structured shot specs deterministically instead of hand-assembling headers:

```bash
opendirector video compile-h3-prompt --file ./shot-01-spec.json
```

After creating the project node (`opendirector video create ...`), verify the persisted `GenerationSpec` against its live active references before submitting:

```bash
opendirector --project PROJECT_UUID video lint-h3-prompt --spec-id SPEC_UUID
```

## 4. Live Storyboard Continuity Audit & Pilot Gate

Before submitting expensive multi-shot video jobs, audit the live project graph (`ProjectSnapshot`):

```bash
opendirector --project PROJECT_UUID video audit-storyboard
# Or scoped to a timeline / canvas group:
opendirector --project PROJECT_UUID video audit-storyboard --timeline-editor TIMELINE_EDITOR_UUID
```

Inspect `gate` (`readyShotSpecIds`, `blockedShotSpecIds`, `estimatedPendingVideoSeconds`), `continuity.warnings` (shots missing shared `Subject` anchors or timeline clips missing `inputConnections`), and `sequenceLint`.

## 5. Multi-Modal Temporal QC (`contact_sheet` + `measuredFacts`)

A `"succeeded"` job receipt proves delivery, not visual or narrative quality, and a single `first_frame` preview cannot reveal frozen motion or mid-shot morphing. Inspect registered project video assets across time:

```bash
opendirector --project PROJECT_UUID video inspect-shot --asset VIDEO_ASSET_UUID --contact-sheet ./shot-01-qc.jpg
# Or inspect a local file in the execution directory:
opendirector video inspect-shot ./shot-01.mp4 --contact-sheet ./shot-01-qc.jpg
```

Keep three layers strictly distinct when reporting to the user:
- **Deterministic `measuredFacts`**: `technical` (`durationSeconds`, `width`x`height`, `hasAudio`, `matchesH3Grid`), `motion` (`meanFrameDelta`, `maxFrameDelta`, `suspectedFrozen`), and `exposure` (`blackFrameIndices`, `blackFrameRatio`).
- **Agent visual review (via contact sheet)**: Identity retention across tiles `#01..#12`, camera trajectory fidelity, hand/prop continuity, and `FL2VA` / `L2VA` landing pose accuracy.
- **User creative approval**: Adopt (`result select`) or reshoot within explicit user authorization. Do **not** import `./shot-01-qc.jpg` as a project asset unless requested.

## 6. Timeline Assembly & Lineage-Aware Single-Shot Revision

1. Assemble verified shot `AssetRef`s onto a single `visual` track in an editable `timeline` `EditorDocument` (`editor create` / `editor save`) with `inputConnections` recording each `slotId`'s `sourceId` shot node.
2. When one shot needs a reshoot (for example `shot-2` has an object-count defect or dialogue change):
   - Regenerate, inspect, and adopt (`result select`) only that shot's node.
   - Sync **only** that clip on the timeline (auto-resolving `clipId` and the adopted `Asset` from `--source-item`, or passing `--clip-id` / `--asset` explicitly):
     ```bash
     opendirector --project PROJECT_UUID video revise-shot \
       --timeline-editor TIMELINE_EDITOR_UUID \
       --source-item SHOT_2_CANVAS_ITEM_UUID
     ```
   - By default `--keep-slot-duration` preserves the clip's existing timeline span (clamped safely if the new asset is shorter) so downstream audio cues and timed text overlays stay aligned; pass `--use-asset-duration` or `--in-point` / `--out-point` when intentionally retiming the cut.
