import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { promisify } from "node:util";
import test from "node:test";

const run = promisify(execFile);
const health = {
  isolated: true, root: "/fixture-projects", assistantFixture: true,
  httpGenerationFixture: true,
};

async function check(apiHealth: object, webHealth = apiHealth, lane = "extendedHttpFixture") {
  const servers = [apiHealth, webHealth].map((body) => createServer((request, response) => {
    assert.equal(request.url, "/api/creation-test-health");
    assert.equal(request.headers["x-opendirector-request"], "1");
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify(body));
  }));
  try {
    for (const server of servers) {
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
    }
    const urls = servers.map((server) => `http://127.0.0.1:${(server.address() as { port: number }).port}`);
    return await run(process.execPath, ["scripts/check-browser-manifest.mjs", "--lane", lane], {
      env: { ...process.env, CREATION_API_URL: urls[0], CREATION_WEB_URL: urls[1] },
      timeout: 15000,
    });
  } finally {
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    })));
  }
}

test("HTTP browser lane checks both required fixture flags", async () => {
  await assert.rejects(check({ ...health, httpGenerationFixture: false }), /httpGenerationFixture/);
  await assert.rejects(check({ ...health, assistantFixture: false }), /assistantFixture/);
  await check(health);
});

test("browser proxy must reach the same isolated API as direct requests", async () => {
  await assert.rejects(check(health, { ...health, root: "/other-projects" }), /same fixture/);
  await assert.rejects(check(health, { ...health, httpGenerationFixture: false }), /httpGenerationFixture/);
  await assert.rejects(check({ ...health, isolated: false }), /isolated/);
});

test("existing fixture lane keeps the generic provider", async () => {
  await assert.rejects(check(health, health, "extendedFixture"), /httpGenerationFixture/);
  const generic = { ...health, httpGenerationFixture: false };
  await check(generic, generic, "extendedFixture");
});

test("a mistyped lane does not silently skip startup validation", async () => {
  await assert.rejects(check(health, health, "extendedHttpFixure"), /Unknown fixture lane/);
});
