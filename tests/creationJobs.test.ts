import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  creationJobs,
  creationJobPreview,
  applyCreationPreview,
} from "../src/backend/creationJobs.ts";
import { creationClient } from "../src/backend/creationClient.ts";
import type { ProjectSnapshot } from "../src/contracts/generated.ts";

function fixture() {
  const snapshot = JSON.parse(
    readFileSync(
      new URL("./fixtures/creation-project.json", import.meta.url),
      "utf8",
    ),
  ) as ProjectSnapshot;

  const active = {
    ...structuredClone(snapshot.jobs[0]!),
    id: crypto.randomUUID(),
    status: "running" as const,
    phase: "prepare" as const,
  };
  return {
    snapshot: {
      ...snapshot,
      project: { ...snapshot.project, id: crypto.randomUUID() },
      jobs: [...snapshot.jobs, active],
    },
    active,
  };
}

test("the history projection retains the execution revision used by confirmed recovery", () => {
  const { snapshot, active } = fixture();
  const job = { ...active, status: "failed" as const, revision: 17 };
  const projected = creationJobs({ ...snapshot, jobs: [job] })[0]!;
  assert.equal(projected.revision, 17);
  assert.equal(projected.status, "failed");
});

test("a slow old preview cannot delay preparation or cancellation metadata", async () => {
  const { snapshot, active } = fixture();
  const asset = snapshot.assets.find(
    (a) => a.id === snapshot.results[0]!.asset.assetId,
  )!;
  let release!: (src: string) => void;
  creationClient(snapshot.project.id).mediaUrl = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const pending = creationJobPreview(snapshot.project.id, asset);
  let rows = creationJobs(snapshot);
  assert.equal(
    rows.find((j) => j.id === active.id)!.activityPhase,
    "preparing",
  );
  rows = creationJobs(
    { ...snapshot, jobs: [snapshot.jobs[0]!, { ...active, phase: "submit" }] },
    rows,
  );
  assert.equal(
    rows.find((j) => j.id === active.id)!.activityPhase,
    "submitting",
  );
  rows = creationJobs(
    {
      ...snapshot,
      jobs: [snapshot.jobs[0]!, { ...active, status: "cancelled" }],
    },
    rows,
  );
  assert.equal(rows.find((j) => j.id === active.id)!.status, "cancelled");
  assert.equal(rows.find((j) => j.id === active.id)!.activityPhase, undefined);
  release("blob:history");
  const preview = await pending;
  const historical = rows.find((j) => j.id !== active.id)!;
  const changed = {
    ...historical,
    message: "结果已保留为候选",
    serviceTask: { cancelRequested: true },
  };
  const hydrated = applyCreationPreview(changed, preview);
  assert.equal(hydrated.message, changed.message);
  assert.equal(hydrated.serviceTask?.cancelRequested, true);
  assert.equal(hydrated.outputs?.[0]?.kind, "image");
  assert.equal(
    hydrated.outputs?.[0] && "src" in hydrated.outputs[0]
      ? hydrated.outputs[0].src
      : undefined,
    "blob:history",
  );
  assert.equal(
    applyCreationPreview(
      { ...changed, preview: { assetId: "replacement", state: "pending" } },
      preview,
    ).outputs,
    undefined,
  );
});

test("a missing preview preserves the successful execution and available previews survive newer snapshots", async () => {
  const { snapshot } = fixture();
  const asset = snapshot.assets.find(
    (a) => a.id === snapshot.results[0]!.asset.assetId,
  )!;
  creationClient(snapshot.project.id).mediaUrl = async () => {
    throw Error("missing media");
  };
  const rows = creationJobs(snapshot);
  const history = rows.find((row) => row.status === "succeeded")!;
  const hydrated = applyCreationPreview(
    history,
    await creationJobPreview(snapshot.project.id, asset),
  );
  assert.equal(hydrated.status, "succeeded");
  assert.equal(hydrated.preview?.state, "unavailable");
  assert.match(hydrated.message!, /文件缺失/);
  assert.equal(
    creationJobs({ ...snapshot, eventCursor: snapshot.eventCursor + 1 }, [
      hydrated,
    ]).find((j) => j.id === hydrated.id)?.preview?.state,
    "pending",
  );
  const ready = {
    ...hydrated,
    preview: { assetId: asset.id, state: "ready" as const },
    outputs: [
      {
        kind: "image" as const,
        src: "blob:cached",
        title: "result",
        mimeType: "image/png",
      },
    ],
  };
  const refreshed = creationJobs(snapshot, [ready]).find(
    (j) => j.id === ready.id,
  )!;
  assert.equal(refreshed.outputs, ready.outputs);
});

test("a failed job carries its service reason so the toast can show it", () => {
  const { snapshot, active } = fixture();
  const failure = {
    code: "provider_error",
    message: "远端模型返回 500，请稍后重试。",
    category: "provider" as const,
    suggestion: "稍后重试或更换模型。",
    stage: "submit" as const,
  };
  const failed = {
    ...active,
    status: "failed" as const,
    errorDetails: failure,
  };
  const row = creationJobs({ ...snapshot, jobs: [failed] }).find(
    (j) => j.id === active.id,
  )!;
  assert.equal(row.status, "failed");
  assert.equal(row.failure, failure.message);
  // A succeeded job has no failure text, so nothing announces a phantom error.
  const done = creationJobs({
    ...snapshot,
    jobs: [{ ...active, status: "succeeded" as const }],
  }).find((j) => j.id === active.id)!;
  assert.equal(done.failure, undefined);
});
