import { readFileSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";
import { CreationClient } from "../src/backend/creationClient.ts";
import { CreationProjection } from "../src/backend/creationProjection.ts";

const snapshot = JSON.parse(readFileSync(process.argv[2], "utf8"));
class FixtureClient extends CreationClient {
  async textContent() { return "source"; }
  async view() {
    return { projectId: this.id, clientId: crypto.randomUUID(), viewport: { x: 0, y: 0, zoom: 1 }, selectedItemIds: [], activeEditorId: null, playheads: [], generationCounts: {} };
  }
}
const client = new FixtureClient(snapshot.project.id);
client.install(snapshot);
const projection = new CreationProjection(client);
const document = await projection.read();
const target = document.nodes.find(node => node.id === process.argv[4]);
assert.ok(target.data.prompt.includes("@"));
assert.equal(target.data.promptContent.filter(part => part.type === "reference").length, 1);
projection.baseline = document;
projection.basis = snapshot;
const edited = { ...document, nodes: document.nodes.map(node => node.id === target.id ? { ...node, data: { ...node.data, prompt: node.data.prompt + " More" } } : node) };
writeFileSync(process.argv[3], JSON.stringify(await projection.prepare(edited)), "utf8");
