import assert from "node:assert/strict";
import test from "node:test";
import {
  readWorkspaceMode,
  saveWorkspaceMode,
  WORKSPACE_MODE_KEY,
} from "../src/canvas/workspaceMode.ts";

test("an unset or unsupported preference keeps the canvas entry point", () => {
  for (const value of [null, "", "simple", "professional", '"agent"']) {
    assert.equal(readWorkspaceMode({ getItem: () => value }), "canvas");
  }
});

test("each saved mode is restored without writing project or other preferences", () => {
  const values = new Map([["opendirector.locale.v1", "zh-CN"]]);
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
  for (const mode of ["agent", "canvas"] as const) {
    assert.equal(saveWorkspaceMode(mode, storage), true);
    assert.equal(readWorkspaceMode(storage), mode);
    assert.deepEqual([...values], [
      ["opendirector.locale.v1", "zh-CN"],
      [WORKSPACE_MODE_KEY, mode],
    ]);
  }
});

test("a denied storage read still opens the canvas", () => {
  assert.equal(readWorkspaceMode({ getItem: () => { throw new Error("denied"); } }), "canvas");
});

test("a failed write is reported without replacing the previous preference", () => {
  const storage = {
    getItem: () => "canvas",
    setItem: () => { throw new Error("quota exceeded"); },
  };
  assert.equal(saveWorkspaceMode("agent", storage), false);
  assert.equal(readWorkspaceMode(storage), "canvas");
});
