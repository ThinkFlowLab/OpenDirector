import assert from "node:assert/strict";
import test from "node:test";
import { createDocument, createNode } from "../src/canvas/model.ts";
import {
  saveStarterGuideChange,
  type StarterGuideSavePlan,
} from "../src/canvas/starterGuideSave.ts";

function fixture() {
  let current = createDocument("sample");
  const before = current;
  const next = { ...before, title: "guide edit" };
  let release!: (ok: boolean) => void;
  const gate = new Promise<boolean>((resolve) => {
    release = resolve;
  });
  const saved: (typeof current)[] = [];
  const plan: StarterGuideSavePlan = {
    read: () => current,
    apply: (base, doc) => {
      if (current === base) current = doc;
    },
    persist: async (doc) => {
      saved.push(doc);
      return gate;
    },
    changed: () => new Error("changed"),
    failed: () => new Error("failed"),
  };
  return {
    before,
    next,
    plan,
    release,
    saved,
    read: () => current,
    set: (doc: typeof current) => {
      current = doc;
    },
  };
}

test("guide save enters history before I/O and preserves edits made while saving", async () => {
  const f = fixture();
  const saving = saveStarterGuideChange(f.next, f.plan);
  assert.equal(f.read(), f.next);
  const newer = {
    ...f.read(),
    nodes: [createNode("text", undefined, { text: "newer canvas edit" })],
  };
  f.set(newer);
  f.release(true);
  await saving;
  assert.equal(f.read(), newer);
  assert.equal(f.read().title, "guide edit");
  assert.equal(f.read().nodes[0]!.data.text, "newer canvas edit");
  assert.deepEqual(f.saved, [f.next]);
});
test("switching projects during save never restores the old project or advances guide", async () => {
  const f = fixture();
  const saving = saveStarterGuideChange(f.next, f.plan);
  const other = createDocument("other");
  f.set(other);
  f.release(true);
  await assert.rejects(saving, /changed/);
  assert.equal(f.read(), other);
});
test("failed save leaves visible edits and rejects advancement without rollback", async () => {
  const f = fixture();
  const saving = saveStarterGuideChange(f.next, f.plan);
  const newer = { ...f.next, title: "newer title" };
  f.set(newer);
  f.release(false);
  await assert.rejects(saving, /failed/);
  assert.equal(f.read(), newer);
});
test("a queued history change wins rather than being overwritten by stale apply", async () => {
  const f = fixture();
  const newer = { ...f.before, title: "queued edit" };
  f.plan.apply = () => f.set(newer);
  await assert.rejects(saveStarterGuideChange(f.next, f.plan), /changed/);
  assert.equal(f.read(), newer);
  assert.equal(f.saved.length, 0);
});
