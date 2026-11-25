import assert from "node:assert/strict";
import test from "node:test";
import { toggleSelection } from "../src/canvas/library/libraryClient.ts";

test("a second pick adds to the selection instead of replacing it", () => {
  const first = toggleSelection(new Set<string>(), "asset-1");
  const second = toggleSelection(first, "asset-2");
  assert.deepEqual([...second].sort(), ["asset-1", "asset-2"]);
});

test("clicking an already selected row removes only that row", () => {
  const both = toggleSelection(
    toggleSelection(new Set<string>(), "asset-1"),
    "asset-2",
  );
  const cleared = toggleSelection(both, "asset-1");
  assert.deepEqual([...cleared], ["asset-2"]);
  assert.deepEqual([...toggleSelection(cleared, "asset-2")], []);
});

test("cross-canvas rows keyed by node id accumulate together", () => {
  // The canvases tab keys rows by node id, so picks made after browsing into
  // another canvas must survive alongside the previous ones.
  let selection = new Set<string>();
  for (const id of ["other-node-1", "other-node-2", "other-node-3"])
    selection = toggleSelection(selection, id);
  assert.equal(selection.size, 3);
  assert.deepEqual(
    [...selection].sort(),
    ["other-node-1", "other-node-2", "other-node-3"],
  );
});
