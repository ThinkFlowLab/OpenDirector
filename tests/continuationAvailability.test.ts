import assert from "node:assert/strict";
import test from "node:test";
import { backendBlocker, type ModelConfig } from "../src/backend/rules.ts";
import { generationDefaults } from "../src/canvas/generationCatalog.ts";
import { createNode } from "../src/canvas/model.ts";
import type { OperationAvailability } from "../src/contracts/generated.ts";
import { setActiveLocale } from "../src/i18n/messages.ts";

for (const locale of ["en-US", "zh-CN"] as const) {
  test(`continuation uses its own decision and retains endpoint checks: ${locale}`, () => {
    setActiveLocale(locale);
    try {
      const config: ModelConfig = {
        id: "h3", kind: "video", protocol: "vllm_omni", modelId: "MiniMaxAI/MiniMax-H3",
        url: "http://models.test/v1", connectionType: "self_hosted", authMode: "none",
        inputRules: { profile: "vllm-omni-h3", allowedKinds: ["text", "image", "video"],
          maxImages: 1, maxVideos: 0, maxAudios: 0, videoModes: ["first_frame", "reference", "continuation"] },
      };
      const settings = { ...generationDefaults("video"), modelConfigId: config.id,
        prompt: "Continue the previous clip", videoMode: "continuation" as const };
      const clip = createNode("video", undefined, { src: "data:video/mp4;base64,AA==", assetState: "ready" });
      const original = JSON.stringify({ settings, clip });
      assert.equal(backendBlocker(settings, [clip], [config]), null);
      const now = Date.now();
      const upload: OperationAvailability = {
        operation: "video_generation", profile: "video_to_video", method: "POST", path: "/v1/videos",
        output: "video", status: "unavailable", reasonCode: "profile_unsupported",
        checkedAt: now, expiresAt: now + 30_000, inputDetails: [],
      };
      const continuation: OperationAvailability = { ...upload, profile: "video_continuation",
        status: "unknown", reasonCode: "profile_not_declared" };
      const publish = (value: OperationAvailability) => {
        config.availability = { configId: config.id, modelId: config.modelId, identity: "test",
          revision: crypto.randomUUID(), autoCheck: true, status: "unknown", reasonCode: "mixed_operations",
          checkedAt: now, expiresAt: now + 30_000, operations: [upload, value] };
      };
      publish(continuation);
      assert.equal(backendBlocker(settings, [clip], [config]), null);
      for (const reasonCode of ["route_disabled", "operation_unsupported", "execution_paused"]) {
        publish({ ...continuation, status: "unavailable", reasonCode });
        assert.notEqual(backendBlocker(settings, [clip], [config]), null, reasonCode);
      }
      publish({ ...continuation, status: "unavailable", reasonCode: "execution_paused",
        declaration: { status: "unknown", reasonCode: "profile_not_declared", checkedAt: now, expiresAt: now + 30_000 },
        execution: { state: "paused", scope: "deployment", checkedAt: now - 6_000, expiresAt: now - 1_000 } });
      assert.equal(backendBlocker(settings, [clip], [config]), null);
      assert.equal(JSON.stringify({ settings, clip }), original);
    } finally { setActiveLocale("zh-CN"); }
  });
}
