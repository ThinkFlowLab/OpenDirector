import assert from "node:assert/strict";
import test from "node:test";
import { PROVIDER_PRESETS } from "../src/canvas/providerPresets.ts";

const ark = PROVIDER_PRESETS.find((preset) => preset.id === "ark")!;

test("the Ark preset covers all three media kinds", () => {
  assert.deepEqual(ark.kinds, ["image", "video", "audio"]);
  assert.equal(ark.protocol, "volcengine");
  assert.equal(ark.url, "https://ark.cn-beijing.volces.com/api/plan/v3");
});

test("picking Ark preselects the documented image models", () => {
  assert.deepEqual(ark.modelsByKind?.image, [
    "doubao-seedream-5.5",
    "doubao-seedream-5.0-pro",
    "doubao-seedream-5.0-flash",
  ]);
});

test("picking Ark preselects both Seedance families", () => {
  assert.deepEqual(ark.modelsByKind?.video, [
    "doubao-seedance-2.5",
    "doubao-seedance-2.5-flash",
    "doubao-seedance-2.0",
    "doubao-seedance-2.0-fast",
    "doubao-seedance-2.0-mini",
  ]);
});

test("picking Ark preselects the voice resource id", () => {
  assert.deepEqual(ark.modelsByKind?.audio, ["seed-tts-2.0"]);
});
