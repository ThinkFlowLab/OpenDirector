import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import sources from "../src/canvas/modelBrands.json" with { type: "json" };
import { modelBrand } from "../src/canvas/modelBrands.ts";

test("model brands recognize organizations and known bare names without assigning unknown aliases", () => {
  assert.equal(modelBrand("MiniMaxAI/MiniMax-H3")?.org, "MiniMaxAI");
  assert.equal(modelBrand("MiniMax-H3")?.org, "MiniMaxAI");
  assert.equal(modelBrand("kling-4.0")?.file, "kling.svg");
  assert.equal(modelBrand("kling-4.0-flash")?.file, "kling.svg");
  assert.equal(modelBrand("deepseek-ai/DeepSeek-V3")?.name, "DeepSeek");
  assert.equal(modelBrand("Qwen3-Omni")?.name, "Qwen");
  assert.equal(modelBrand("Phi-4")?.name, "Microsoft");
  assert.equal(modelBrand("gpt-4.1")?.file, "openai.svg");
  assert.equal(modelBrand("kimi-k2")?.file, "kimi.svg");
  assert.equal(modelBrand("my-private-model"), undefined);
  assert.equal(modelBrand("", "MiniMaxAI")?.name, "MiniMax");
});

test("mapped brand SVGs resolve from the installed Lobe dependency", () => {
  const require = createRequire(import.meta.url);
  for (const logo of sources.logos) {
    const file = require.resolve(`@lobehub/icons-static-svg/icons/${logo.file}`);
    assert.match(readFileSync(file, "utf8"), /<svg[\s>]/);
  }
});
