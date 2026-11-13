import assert from "node:assert/strict";
import test from "node:test";
import { backendBlocker, type ModelConfig } from "../src/backend/rules.ts";
import { generationDefaults } from "../src/canvas/generationCatalog.ts";
import { createNode } from "../src/canvas/model.ts";
import type { OperationAvailability } from "../src/contracts/generated.ts";
import { setActiveLocale } from "../src/i18n/messages.ts";

for (const locale of ["en-US", "zh-CN"] as const) {
  test(`image admission selects the transmitted image count: ${locale}`, () => {
    setActiveLocale(locale);
    try {
      const now = Date.now();
      const operation = (profile: string, maximum: number): OperationAvailability => ({
        operation: "image_edit", profile, method: "POST", path: "/v1/images/edits", output: "image",
        status: "available", reasonCode: "supported", checkedAt: now, expiresAt: now + 30_000,
        inputDetails: [{ name: "image", source: "service", support: "supported", minCount: 2,
          maxCount: maximum, min: null, max: null, multipleOf: null, values: null }],
      });
      const single: OperationAvailability = { ...operation("image_to_image", 2),
        status: "unavailable", reasonCode: "required_inputs_missing" };
      const multi = operation("images_to_image", 2);
      const config: ModelConfig = { id: "images", kind: "image", protocol: "openai", modelId: "fixture",
        url: "http://models.test/v1", connectionType: "self_hosted", authMode: "none",
        inputRules: { profile: "fixture", allowedKinds: ["text", "image"],
          maxImages: 4, maxVideos: 0, maxAudios: 0, videoModes: [] } };
      const publish = (operations: OperationAvailability[]) => {
        config.availability = { configId: config.id, modelId: config.modelId, identity: "test",
          revision: crypto.randomUUID(), autoCheck: true, status: "unknown", reasonCode: "mixed_operations",
          checkedAt: now, expiresAt: now + 30_000, operations };
      };
      const settings = { ...generationDefaults("image"), modelConfigId: config.id, prompt: "Combine these images",
        aspectRatio: "auto", resolution: "auto" };
      const images = Array.from({ length: 3 }, () => createNode("image", undefined,
        { src: "data:image/png;base64,AA==", assetState: "ready" }));
      const original = JSON.stringify({ settings, images });
      publish([single, multi]);
      assert.equal(backendBlocker(settings, [], [config]), null);
      assert.notEqual(backendBlocker(settings, images.slice(0, 1), [config]), null);
      assert.equal(backendBlocker(settings, images.slice(0, 2), [config]), null);
      assert.notEqual(backendBlocker(settings, images, [config]), null);

      publish([operation("image_to_image", 1), multi]);
      assert.equal(backendBlocker(settings, images.slice(0, 2), [config]), null,
        "the count limit must come from the same multi-image entry");
      const missing = createNode("image", undefined, { assetState: "missing" });
      assert.equal(backendBlocker(settings, [...images.slice(0, 2), missing], [config]), null);
      assert.notEqual(backendBlocker(settings, images.slice(0, 2),
        [{ ...config, inputRules: { ...config.inputRules, maxImages: 1 } }]), null);

      for (const reasonCode of ["route_disabled", "execution_paused"]) {
        publish([single, { ...multi, status: "unavailable", reasonCode }]);
        assert.notEqual(backendBlocker(settings, images.slice(0, 2), [config]), null);
      }
      for (const operations of [[single], [single, { ...multi, status: "unknown" as const }],
        [single, { ...multi, status: "unavailable" as const, expiresAt: now - 1 }]]) {
        publish(operations);
        assert.equal(backendBlocker(settings, images.slice(0, 2), [config]), null);
      }
      assert.equal(JSON.stringify({ settings, images }), original);
    } finally { setActiveLocale("zh-CN"); }
  });
}
