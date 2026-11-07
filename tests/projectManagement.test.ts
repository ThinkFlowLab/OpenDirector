import assert from "node:assert/strict";
import test from "node:test";
import type { ProjectSnapshot } from "../src/contracts/generated.ts";
import type { WorkspaceProject } from "../src/backend/workspace.ts";
import { deleteOpenProject } from "../src/canvas/projectManagement.ts";

const project = (name: string): WorkspaceProject => ({
  id: crypto.randomUUID(),
  name,
  path: `/projects/${name}`,
});
const snapshot = (id: string): ProjectSnapshot =>
  ({ project: { id, name: "Open", revision: 3 } }) as ProjectSnapshot;

test("deleting the open project resolves once trash is accepted, not after the next canvas", async () => {
  const open = project("Open"),
    next = project("Next");
  const known = snapshot(open.id);
  const order: string[] = [];
  let finishOpening!: () => void;
  const opening = new Promise<void>((resolve) => {
    finishOpening = resolve;
  });
  let settled = false;
  await deleteOpenProject(open, {
    snapshot: known,
    flush: async () => {
      order.push("flush");
    },
    list: async () => ({ projects: [open, next] }),
    trash: async (item, value) => {
      order.push("trash");
      assert.equal(item, open);
      // The open project's in-memory snapshot is the delete basis: no reread.
      assert.equal(value, known);
    },
    openNext: async (item, taken) => {
      order.push("open");
      assert.equal(item, next);
      assert.ok(taken.has("next"));
      await opening;
    },
    fail: () => order.push("fail"),
    settle: () => {
      settled = true;
    },
  });
  assert.deepEqual(order, ["flush", "trash", "open"]);
  // The confirmation dialog may close while the replacement canvas loads.
  assert.equal(settled, false);
  finishOpening();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, true);
});

test("a failed flush never deletes the project or starts another canvas", async () => {
  const open = project("Open");
  const order: string[] = [];
  await assert.rejects(
    deleteOpenProject(open, {
      snapshot: snapshot(open.id),
      flush: async () => {
        throw new Error("flush failed");
      },
      list: async () => {
        order.push("list");
        return { projects: [] };
      },
      trash: async () => {
        order.push("trash");
      },
      openNext: async () => {
        order.push("open");
      },
      fail: () => order.push("fail"),
      settle: () => order.push("settle"),
    }),
    /flush failed/,
  );
  assert.deepEqual(order, []);
});

test("a failed replacement open surfaces and still settles the switching state", async () => {
  const open = project("Open");
  const failures: unknown[] = [];
  let settled = false;
  await deleteOpenProject(open, {
    snapshot: snapshot(open.id),
    flush: async () => {},
    list: async () => ({ projects: [open] }),
    trash: async () => {},
    openNext: async () => {
      throw new Error("next canvas unavailable");
    },
    fail: (error) => failures.push(error),
    settle: () => {
      settled = true;
    },
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, true);
  assert.equal(failures.length, 1);
  assert.match(String(failures[0]), /next canvas unavailable/);
});
