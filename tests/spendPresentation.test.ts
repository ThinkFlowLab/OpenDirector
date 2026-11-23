import assert from "node:assert/strict";
import test from "node:test";
import type { PriceLine, SpendQuote } from "../src/contracts/generated.ts";
import { generationOutput, money, uniformOutputPrice } from "../src/canvas/spendPresentation.ts";

function quote(operations: string[], count: number, candidates?: number): SpendQuote {
  const lines: PriceLine[] = operations.map(operation => ({
    operation, modelConfigId: "model", modelId: "model", source: "unknown",
    sourceVersion: null, price: null, quantity: null, amount: null,
  }));
  return {inputFingerprint: "0".repeat(64), count, candidates, lines};
}

test("the requested output determines the action even when reference music uses two calls", () => {
  assert.equal(generationOutput(quote(["image"], 3)), "image");
  assert.equal(generationOutput(quote(["score", "music"], 1)), "music");
  assert.equal(generationOutput(quote(["video", "video"], 1, 2)), "video");
  assert.equal(generationOutput(quote(["image", "video"], 1, 2)), "tasks");
  // A text-generation member contributes to the candidate count without a priced call.
  assert.equal(generationOutput(quote(["image"], 1, 2)), "tasks");
});

test("monetary labels preserve exact decimal rates and the project currency in both locales", () => {
  assert.equal(money("1.2", "USD", "zh-CN"), "1.20 美元");
  assert.equal(money("2.4", "CNY", "zh-CN"), "2.40 人民币");
  assert.match(money("0.000000000000000000000001", "USD", "en-US"), /^USD\s0\.000000000000000000000001$/);
  assert.match(money("999999999999.999999999999", "CNY", "en-US"), /^CNY\s999,999,999,999\.999999999999$/);
});

test("the unit-price shortcut preserves upper bounds and multi-call price details", () => {
  const original = quote(["image"], 3);
  const line: PriceLine = {...original.lines[0], amount: "0.40", price: {currency: "USD", rate: "0.40", unit: "request"}};
  assert.deepEqual(uniformOutputPrice({...original, lines: [line]}), {amount: "0.40", currency: "USD", model: "model"});
  assert.equal(uniformOutputPrice({...original, lines: [{...line, quantityBasis: "maximum"}]}), undefined);
  assert.equal(uniformOutputPrice({...original, lines: [line, line]}), undefined);
});
