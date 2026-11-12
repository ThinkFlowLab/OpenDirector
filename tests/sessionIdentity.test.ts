import assert from "node:assert/strict";
import test from "node:test";
import { createSessionIdentity } from "../src/backend/sessionIdentity.ts";

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}

test("reload supersedes even an unacknowledged acquisition", () => {
  const tab = storage();
  const first = createSessionIdentity(tab, "navigate");
  const accepted = first.issue();
  first.accept(accepted);
  const pending = first.issue();
  assert.equal(first.accepted, accepted);
  const reload = createSessionIdentity(tab, "reload");
  assert.equal(reload.id, first.id);
  assert.ok(reload.issue() > pending);
  assert.equal(reload.accepted, 0);
});

test("a new window with copied storage gets a different owner", () => {
  const tab = storage();
  const original = createSessionIdentity(tab, "navigate");
  original.issue();
  const popup = createSessionIdentity(tab, "navigate");
  assert.notEqual(popup.id, original.id);
  assert.equal(popup.issue(), 1);
});

test("out-of-order responses do not roll back the accepted generation", () => {
  const tab = createSessionIdentity(storage(), "navigate");
  const old = tab.issue(),
    newer = tab.issue();
  tab.accept(newer);
  tab.accept(old);
  assert.equal(tab.accepted, newer);
});

test("corrupt and unavailable storage cannot claim a previous owner", () => {
  for (const value of [
    "not json",
    JSON.stringify({ id: crypto.randomUUID(), generation: -1 }),
  ]) {
    const tab = { getItem: () => value, setItem: () => {} };
    assert.equal(createSessionIdentity(tab, "reload").issue(), 1);
  }
  const denied = {
    getItem: () => {
      throw Error("denied");
    },
    setItem: () => {
      throw Error("denied");
    },
  };
  assert.notEqual(
    createSessionIdentity(denied, "reload").id,
    createSessionIdentity(denied, "reload").id,
  );
});
