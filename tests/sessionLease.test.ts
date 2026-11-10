import assert from "node:assert/strict";
import test from "node:test";
import { releaseStaleSession } from "../src/backend/api.ts";

function locks(held: string[]) {
  const requested: string[] = [];
  return {
    requested,
    request: async (name: string) => {
      requested.push(name);
    },
    query: async () => ({ held: held.map((name) => ({ name })) }),
  };
}
const noPause = async () => {};

test("a reloaded tab releases its previous page's unreleased lease", async () => {
  const released: string[] = [];
  const browser = locks([]);
  assert.equal(
    await releaseStaleSession("old", "new", browser, async (id) => released.push(id), noPause),
    true,
  );
  assert.deepEqual(released, ["old"]);
  assert.deepEqual(browser.requested, ["opendirector.session.new"]);
});

test("a duplicated tab never releases the lease of a live window", async () => {
  const released: string[] = [];
  const browser = locks(["opendirector.session.old"]);
  assert.equal(
    await releaseStaleSession("old", "new", browser, async (id) => released.push(id), noPause),
    false,
  );
  assert.deepEqual(released, []);
});

test("a first load or a browser without Web Locks releases nothing", async () => {
  const released: string[] = [];
  const release = async (id: string) => released.push(id);
  assert.equal(await releaseStaleSession(null, "new", locks([]), release, noPause), false);
  assert.equal(await releaseStaleSession("old", "new", undefined, release, noPause), false);
  assert.deepEqual(released, []);
});

test("a failed release does not block the page", async () => {
  assert.equal(
    await releaseStaleSession("old", "new", locks([]), async () => {
      throw new Error("offline");
    }, noPause),
    true,
  );
});

test("a previous page that is still unloading is released once its lock is gone", async () => {
  const released: string[] = [];
  let checks = 0;
  const browser = {
    request: async () => {},
    query: async () => ({ held: ++checks < 3 ? [{ name: "opendirector.session.old" }] : [] }),
  };
  assert.equal(
    await releaseStaleSession("old", "new", browser, async (id) => released.push(id), noPause),
    true,
  );
  assert.deepEqual(released, ["old"]);
});
