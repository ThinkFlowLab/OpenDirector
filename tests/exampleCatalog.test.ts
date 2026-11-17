import assert from "node:assert/strict";
import test from "node:test";
import {
  BUILTIN_EXAMPLE_CATALOG,
  EXAMPLE_CATALOG_SCHEMA_VERSION,
  availableExamples,
  compareAppVersions,
  exampleById,
  exampleUrlAllowed,
  loadExampleCatalog,
  parseExampleCatalog,
  parseExampleEntry,
} from "../src/canvas/workspace/example/exampleCatalog.ts";

const validItem = {
  id: "image-canvas",
  title: { "zh-CN": "图像示例", "en-US": "Image example" },
  url: "https://lz.qaiu.top/parser?url=https://example.test/x&pwd=1",
  bytes: 1024,
  sha256: "a".repeat(64),
};

function catalogWith(items: unknown[]) {
  return { schemaVersion: EXAMPLE_CATALOG_SCHEMA_VERSION, items };
}

test("the shipped catalog is valid and offers both samples", () => {
  const parsed = parseExampleCatalog(BUILTIN_EXAMPLE_CATALOG);
  assert.deepEqual(parsed.rejected, []);
  assert.equal(parsed.catalog.items.length, 2);
  assert.deepEqual(
    parsed.catalog.items.map((item) => item.id),
    ["image-canvas", "video-canvas"],
  );
  assert.equal(exampleById(parsed.catalog, "video-canvas")?.contentKind, "zip-wrapper");
});

test("only https on an allowed host is downloadable", () => {
  assert.equal(exampleUrlAllowed("https://lz.qaiu.top/parser?url=x"), true);
  assert.equal(exampleUrlAllowed("https://bucket.oss-cn-hangzhou.aliyuncs.com/a.canvas"), true);
  assert.equal(exampleUrlAllowed("http://lz.qaiu.top/parser?url=x"), false);
  assert.equal(exampleUrlAllowed("https://evil.test/a.canvas"), false);
  assert.equal(exampleUrlAllowed("not a url"), false);
});

test("a bad row is dropped without hiding the good ones", () => {
  const parsed = parseExampleCatalog(
    catalogWith([
      validItem,
      { ...validItem, id: "insecure", url: "http://lz.qaiu.top/x" },
      { ...validItem, id: "foreign", url: "https://evil.test/x" },
      { ...validItem, id: "image-canvas" },
      { ...validItem, id: "no-title", title: { "zh-CN": "" } },
      { ...validItem, id: "bad-digest", sha256: "xyz" },
      { ...validItem, id: "bad-version", minAppVersion: "v1" },
    ]),
  );
  assert.deepEqual(
    parsed.catalog.items.map((item) => item.id),
    ["image-canvas"],
  );
  const reasons = parsed.rejected.map((entry) => entry.reason);
  assert.ok(reasons.some((reason) => reason.includes("allowed host")));
  assert.ok(reasons.includes("duplicate id"));
  assert.ok(reasons.some((reason) => reason.includes("zh-CN")));
  assert.ok(reasons.some((reason) => reason.includes("sha256")));
  assert.ok(reasons.some((reason) => reason.includes("minAppVersion")));
});

test("structural problems reject the document instead of half-parsing it", () => {
  assert.throws(() => parseExampleCatalog(null), /not an object/);
  assert.throws(
    () => parseExampleCatalog({ schemaVersion: 2, items: [] }),
    /schemaVersion/,
  );
  assert.throws(
    () => parseExampleCatalog({ schemaVersion: 1, items: "nope" }),
    /items must be an array/,
  );
});

test("an entry keeps its optional hints and defaults contentKind to auto", () => {
  const parsed = parseExampleEntry({ ...validItem, sha256: undefined });
  assert.ok("entry" in parsed);
  assert.equal(parsed.entry.contentKind, "auto");
  assert.equal(parsed.entry.sha256, undefined);
  assert.equal(parsed.entry.inner, undefined);
});

test("versions compare numerically, not as strings", () => {
  assert.equal(compareAppVersions("0.1.4", "0.1.4"), 0);
  assert.equal(compareAppVersions("0.1.10", "0.1.9"), 1);
  assert.equal(compareAppVersions("0.2", "0.10"), -1);
  assert.equal(compareAppVersions("1", "1.0.0"), 0);
});

test("newer samples stay out of older builds", () => {
  const catalog = parseExampleCatalog(
    catalogWith([validItem, { ...validItem, id: "future", minAppVersion: "0.2.0" }]),
  ).catalog;
  assert.deepEqual(
    availableExamples(catalog, "0.1.4").map((item) => item.id),
    ["image-canvas"],
  );
  assert.deepEqual(
    availableExamples(catalog, "0.2.0").map((item) => item.id),
    ["image-canvas", "future"],
  );
});

function stubFetch(
  responses: Record<string, () => Promise<Response> | Response>,
): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const handler = responses[url];
    if (!handler) throw new Error(`unexpected url ${url}`);
    return handler();
  }) as typeof fetch;
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

test("the remote catalog wins when it is usable", async () => {
  const result = await loadExampleCatalog({
    remoteUrl: "https://example.test/catalog.json",
    fetchImpl: stubFetch({
      "https://example.test/catalog.json": () =>
        json(catalogWith([{ ...validItem, id: "remote-only" }])),
    }),
  });
  assert.equal(result.source, "remote");
  assert.deepEqual(
    result.catalog.items.map((item) => item.id),
    ["remote-only"],
  );
});

test("a broken remote catalog falls back to the bundled copy", async () => {
  const result = await loadExampleCatalog({
    remoteUrl: "https://example.test/catalog.json",
    builtinUrl: "/example-canvases.json",
    fetchImpl: stubFetch({
      "https://example.test/catalog.json": () => json({ schemaVersion: 99, items: [] }),
      "/example-canvases.json": () => json(catalogWith([{ ...validItem, id: "bundled" }])),
    }),
  });
  assert.equal(result.source, "builtin");
  assert.deepEqual(
    result.catalog.items.map((item) => item.id),
    ["bundled"],
  );
});

test("both files missing still leaves the compiled-in samples", async () => {
  const result = await loadExampleCatalog({
    remoteUrl: "https://example.test/catalog.json",
    fetchImpl: stubFetch({
      "https://example.test/catalog.json": () => {
        throw new Error("offline");
      },
      "/example-canvases.json": () => {
        throw new Error("offline");
      },
    }),
  });
  assert.equal(result.source, "code");
  assert.equal(result.catalog.items.length, 2);
});
