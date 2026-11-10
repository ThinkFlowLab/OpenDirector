import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  CreationClient,
  CreationCommandError,
} from "../src/backend/creationClient.ts";
import { timelinePublication } from "../src/backend/timelinePublication.ts";
import type {
  CommandReceipt,
  ProjectSnapshot,
} from "../src/contracts/generated.ts";

for (const outcome of ["unknown", "conflict"] as const) {
  test(`timeline publication preserves its accepted render basis after ${outcome} and a concurrent edit`, async () => {
    const snapshot = JSON.parse(
      readFileSync(
        new URL("./fixtures/creation-project.json", import.meta.url),
        "utf8",
      ),
    ) as ProjectSnapshot;
    const item = snapshot.canvasItems.find(
      (entry) => entry.kind === "timeline",
    )!;
    assert.equal(item.binding.role, "editor");
    if (item.binding.role !== "editor")
      throw new Error("Expected fixture editor");
    const editorId = item.binding.objectRef.id;
    const editor = snapshot.editorDocuments.find(
      (entry) => entry.id === editorId,
    )!;
    const output = snapshot.assets.find((entry) => entry.kind === "video")!;
    const client = new CreationClient(snapshot.project.id);
    client.install(snapshot);
    client.assetForSource = () => output;
    const publish = timelinePublication(client, snapshot, item.id);
    const commands: Parameters<CreationClient["command"]>[] = [];
    client.command = async (...args) => {
      commands.push(structuredClone(args));
      if (commands.length === 1 || outcome === "conflict") {
        if (outcome === "unknown") throw new TypeError("offline");
        throw new CreationCommandError({
          commandId: args[4]!,
          projectId: snapshot.project.id,
          inputFingerprint: "sha256:" + "0".repeat(64),
          status: "rejected",
          changed: [],
          jobIds: [],
          eventCursor: snapshot.eventCursor,
          issues: [
            {
              code: "revision_conflict",
              message: "Source changed",
              objectId: editor.id,
              field: null,
            },
          ],
        });
      }
      return { status: "applied" } as CommandReceipt;
    };
    const result = {
      kind: "video" as const,
      src: "blob:render",
      mimeType: "video/mp4",
      title: "Rendered text",
    };
    await assert.rejects(
      publish(result),
      outcome === "unknown" ? /offline/ : /Source changed/,
    );
    client.install({
      ...snapshot,
      eventCursor: snapshot.eventCursor + 1,
      editorDocuments: snapshot.editorDocuments.map((entry) =>
        entry.id === editor.id
          ? { ...entry, revision: entry.revision + 1 }
          : entry,
      ),
      canvasItems: snapshot.canvasItems.map((entry) =>
        entry.id === item.id
          ? { ...entry, locked: true, revision: entry.revision + 1 }
          : entry,
      ),
    });
    if (outcome === "conflict")
      await assert.rejects(publish(result), /Source changed/);
    else assert.equal(await publish(result), true);
    assert.deepEqual(commands[1], commands[0]);
    const [type, payload, versions, , commandId] = commands[0]!;
    assert.equal(type, "timeline.publishRender");
    assert.ok("asset" in payload && payload.asset.assetId === output.id);
    assert.equal(
      versions!.find((entry) => entry.objectType === "editor_document")!
        .revision,
      editor.revision,
    );
    assert.equal(
      versions!.find((entry) => entry.objectType === "canvas_item")!.revision,
      item.revision,
    );
    assert.equal(typeof commandId, "string");
  });
}
