import assert from "node:assert/strict";
import test from "node:test";
import { CreationClient } from "../src/backend/creationClient.ts";
import {
  TimelinePackageImport,
  exportTimelinePackage,
} from "../src/backend/timelinePackages.ts";

test("native import retries fixed request and upload identity after unknown delivery", async () => {
  const original = globalThis.fetch;
  const writes: Record<string, unknown>[] = [];
  const uploads: string[] = [];
  let lost = true,
    refreshes = 0;
  const receipt = {
    operationId: "",
    status: "applied",
    editorId: "editor",
    registeredAssetIds: [],
    receipt: null,
    errorCode: null,
  };
  globalThis.fetch = async (input, options) => {
    const url = String(input);
    if (options?.method === "PUT") {
      uploads.push(url);
      return Response.json({ fingerprint: "sha256:" + "a".repeat(64) });
    }
    if (options?.method === "POST") {
      const body = JSON.parse(String(options.body));
      writes.push(body);
      receipt.operationId = body.operationId;
      if (lost) throw new TypeError("connection lost");
      return Response.json(receipt);
    }
    if (lost) return Response.json({ detail: "not found" }, { status: 404 });
    return Response.json(receipt);
  };
  try {
    const client = new CreationClient("project");
    client.refresh = async () => {
      refreshes++;
      return client.snapshot;
    };
    const operation = new TimelinePackageImport(
      client,
      new File(["archive"], "example.timeline.zip"),
      { editorId: "existing", revision: 3 },
    );
    await assert.rejects(operation.run());
    lost = false;
    assert.equal((await operation.run()).status, "applied");
    assert.equal(uploads.length, 1);
    assert.equal(writes.length, 1); // Recovery queries the original operation before submitting again.
    assert.equal(writes[0].replaceEditorId, "existing");
    assert.equal(writes[0].expectedRevision, 3);
    assert.equal(refreshes, 1);
  } finally {
    globalThis.fetch = original;
  }
});

test("native export sends the exact saved document revision and returns archive bytes", async () => {
  const original = globalThis.fetch;
  let requested = "";
  globalThis.fetch = async (input) => {
    requested = String(input);
    return new Response("ZIP");
  };
  try {
    const blob = await exportTimelinePackage(
      new CreationClient("project"),
      "editor",
      7,
    );
    assert.equal(await blob.text(), "ZIP");
    assert.equal(
      requested,
      "/api/creation/projects/project/timelines/editor/package?revision=7",
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("native replacement rejection stays rejected and never refreshes as a successful import", async () => {
  const original = globalThis.fetch;
  const writes: Record<string, unknown>[] = [];
  let refreshes = 0;
  const rejected = {
    operationId: "",
    status: "rejected",
    editorId: "existing",
    registeredAssetIds: ["retained"],
    errorCode: null,
    receipt: {
      commandId: "apply",
      projectId: "project",
      inputFingerprint: "0".repeat(64),
      status: "rejected",
      changed: [],
      jobIds: [],
      eventCursor: 1,
      issues: [
        {
          code: "revision_conflict",
          message: "Changed",
          objectId: "existing",
          field: null,
        },
      ],
    },
  };
  globalThis.fetch = async (_input, options) => {
    if (options?.method === "PUT")
      return Response.json({ fingerprint: "sha256:" + "b".repeat(64) });
    if (options?.method === "POST")
      writes.push(JSON.parse(String(options.body)));
    return Response.json(rejected);
  };
  try {
    const client = new CreationClient("project");
    client.refresh = async () => {
      refreshes++;
      return client.snapshot;
    };
    const target = { editorId: "existing", revision: 2 };
    const operation = new TimelinePackageImport(
      client,
      new File(["zip"], "x.timeline.zip"),
      target,
    );
    target.revision = 99;
    await assert.rejects(operation.run(), /Changed/);
    await assert.rejects(operation.run(), /Changed/);
    assert.equal(refreshes, 0);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].expectedRevision, 2);
  } finally {
    globalThis.fetch = original;
  }
});
