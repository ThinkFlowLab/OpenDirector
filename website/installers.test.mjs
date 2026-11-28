import assert from "node:assert/strict";
import test from "node:test";
import { resolveInstallers } from "./installers.mjs";

const official = "ThinkFlowLab/OpenDirector";
const fork = "FayeSpica/OpenDirector";
const testTag = "v0.1.4-desktop-test.23";
const mac = "mac-arm64-adhoc.dmg";
const windows = "win-x64-unsigned.exe";

function release(tag, packages, repository = official) {
  const base = `https://github.com/${repository}/releases`;
  return {
    tag_name: tag,
    draft: false,
    prerelease: repository === fork,
    html_url: `${base}/tag/${tag}`,
    assets: packages.map(suffix => {
      const name = `OpenDirector-${tag.split("-")[0]}-${suffix}`;
      return { name, state: "uploaded", size: 42, browser_download_url: `${base}/download/${tag}/${name}?id=42` };
    }),
  };
}

function github(...routes) {
  return async url => {
    const { pathname, search } = new URL(url);
    const [path, response] = routes.shift() ?? [];
    assert.equal(pathname + search, `/repos/${path}`, `unexpected request: ${url}`);
    return response;
  };
}

const firstPage = `${official}/releases?per_page=100&page=1`;
const secondPage = `${official}/releases?per_page=100&page=2`;
const fallback = `${fork}/releases/tags/${testTag}`;
const nextPage = { headers: { Link: `<https://api.github.com/repos/${secondPage}>; rel="next"` } };

test("selects the highest published stable version independently for each platform across pages", async () => {
  const both = release("v1.9.9", [mac, windows]);
  const winOnly = release("v1.10.0", [windows, "mac-x64-adhoc.dmg", `${mac}.sha256`]);
  const entries = [
    { ...release("v2.0.0", [mac, windows]), draft: true },
    { ...release("v3.0.0", [mac, windows]), prerelease: true },
    release("v4.0.0-rc.1", [mac, windows]),
    release("v2.00.0", [mac, windows]),
    release("v1.11.0", []),
    both,
  ];
  const installers = await resolveInstallers(github(
    [firstPage, Response.json(entries, nextPage)],
    [secondPage, Response.json([winOnly])],
  ));
  assert.deepEqual(installers, {
    mac: { url: both.assets[0].browser_download_url, notes: both.html_url, version: "v1.9.9", test: false },
    windows: { url: winOnly.assets[0].browser_download_url, notes: winOnly.html_url, version: "v1.10.0", test: false },
  });
});

test("uses only the pinned public test release for a platform with no official installer", async () => {
  const winOnly = release("v1.0.0", [windows, mac, mac, mac]);
  winOnly.assets[1].state = "starter";
  winOnly.assets[2].size = 0;
  winOnly.assets[3].name = `OpenDirector-v0.9.0-${mac}`;
  const preview = release(testTag, [mac, windows], fork);
  const installers = await resolveInstallers(github(
    [firstPage, Response.json([winOnly])],
    [fallback, Response.json(preview)],
  ));
  assert.deepEqual(installers.mac, { url: preview.assets[0].browser_download_url, notes: preview.html_url, version: testTag, test: true });
  assert.equal(installers.windows.url, winOnly.assets[0].browser_download_url);
});

test("omits assets unavailable from both the official and pinned public release", async () => {
  const preview = release(testTag, [mac], fork);
  const resolve = candidate => resolveInstallers(github([firstPage, Response.json([])], [fallback, Response.json(candidate)]));
  assert.deepEqual(Object.keys(await resolve(preview)), ["mac"]);
  assert.deepEqual(await resolve({ ...preview, draft: true }), {});
});

test("fails the build if a release API page or fallback request fails", async () => {
  await assert.rejects(resolveInstallers(github(
    [firstPage, Response.json([release("v1.0.0", [mac, windows])], nextPage)],
    [secondPage, new Response(null, { status: 403 })],
  )), /GitHub Releases request failed \(403\)/);
  await assert.rejects(resolveInstallers(github(
    [firstPage, Response.json([])], [fallback, new Response(null, { status: 503 })],
  )), /GitHub Releases request failed \(503\)/);
  await assert.rejects(resolveInstallers(async () => { throw new Error("network timeout"); }), /network timeout/);
});

test("rejects an installer URL outside its source repository", async () => {
  const candidate = release("v1.0.0", [mac, windows]);
  candidate.assets[0].browser_download_url = "https://example.org/unexpected.dmg";
  await assert.rejects(resolveInstallers(github([firstPage, Response.json([candidate])])), /Unexpected GitHub download URL/);
});
