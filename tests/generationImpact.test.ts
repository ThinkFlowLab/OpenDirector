import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { CreationClient } from "../src/backend/creationClient.ts";
import { generationImpactText } from "../src/backend/generationImpactText.ts";
import { catalogs, setActiveLocale } from "../src/i18n/messages.ts";
import { defaultTranslate as tNow } from "../src/canvas/assistantTranslate.ts";
import type { GenerationImpactReport, ProjectSnapshot } from "../src/contracts/generated.ts";

test("impact reads send the typed query without opening a session or replacing a newer snapshot", async () => {
  const snapshot = JSON.parse(readFileSync(new URL("fixtures/creation-project.json", import.meta.url), "utf8")) as ProjectSnapshot;
  const client = new CreationClient(snapshot.project.id);
  client.install(snapshot);
  const newer = { ...snapshot, eventCursor: snapshot.eventCursor + 1 };
  const report = { analysisVersion: 1, projectVersion: { objectType: "project", id: snapshot.project.id, revision: snapshot.project.revision },
    eventCursor: snapshot.eventCursor, rootSpecIds: [snapshot.generationSpecs[0]!.id], items: [], dependencies: [], timelineConsumers: [] } satisfies GenerationImpactReport;
  const original = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async (url, options) => {
    requests++;
    assert.equal(url, `/api/creation/projects/${snapshot.project.id}/queries`);
    assert.equal(options?.method, "POST");
    const query = JSON.parse(String(options?.body));
    assert.equal(query.type, "generation.impact");
    assert.equal(query.projectId, snapshot.project.id);
    assert.deepEqual(query.rootSpecIds, report.rootSpecIds);
    assert.match(query.queryId, /^[0-9a-f-]{36}$/);
    assert.ok(options?.signal);
    client.install(newer);
    return Response.json(report);
  };
  try {
    assert.deepEqual(await client.generationImpact(report.rootSpecIds), report);
    assert.equal(client.snapshot, newer);
    assert.equal(requests, 1);
  } finally { globalThis.fetch = original; }
});

test("impact states, reasons and fallback switch languages without changing business codes", () => {
  const schema = JSON.parse(readFileSync(new URL("../src/contracts/creation.schema.json", import.meta.url), "utf8"));
  const defs = schema.output.$defs;
  const codes = [...defs.GenerationImpactItem.properties.reuseState.enum,
    ...defs.GenerationImpactItem.properties.inputState.enum,
    ...defs.GenerationImpactItem.properties.relation.enum,
    ...defs.ImpactReason.properties.code.enum, "impact_scope_exceeded", "clip", "text_overlay"];
  const localized: Record<string, string[]> = {};
  try {
    for (const locale of ["en-US", "zh-CN"] as const) {
      setActiveLocale(locale);
      localized[locale] = codes.map(code => {
        const value = generationImpactText(code, tNow);
        assert.notEqual(value, code);
        assert.notEqual(value, generationImpactText("future_code", tNow));
        assert.equal(typeof catalogs[locale][`generationImpact.${code}`], "string");
        assert.equal(/[\u3400-\u9fff]/.test(value), locale === "zh-CN");
        return value;
      });
      const fallback = generationImpactText("<script>private unknown code</script>", tNow);
      assert.ok(fallback && !fallback.includes("script"));
    }
    assert.notDeepEqual(localized["en-US"], localized["zh-CN"]);
  } finally { setActiveLocale("zh-CN"); }
});

test("impact queries can request the supported larger node budget without serializing read controls", async () => {
  const client = new CreationClient("00000000-0000-0000-0000-000000000001");
  const original = globalThis.fetch;
  let body: Record<string, unknown> = {};
  globalThis.fetch = async (_url, options) => {
    body = JSON.parse(String(options?.body));
    assert.ok(options?.signal);
    return Response.json({});
  };
  try {
    await client.generationImpact(["00000000-0000-0000-0000-000000000100"], {
      maxNodes: 10000, signal: new AbortController().signal, attempts: 1,
    });
    assert.equal(body.maxNodes, 10000);
    assert.equal(body.signal, undefined);
    assert.equal(body.attempts, undefined);
  } finally { globalThis.fetch = original; }
});
