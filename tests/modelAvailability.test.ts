import assert from "node:assert/strict";
import test from "node:test";
import {
  availabilityBlocker,
  availabilityInputLimit,
  availabilityDelay,
  availabilityMatchesModel,
  availabilityModelKey,
  currentAvailability,
  failedAvailability,
  nextAvailabilityExpiry,
  receiveAvailability,
  type AvailabilityClock,
} from "../src/backend/availability.ts";
import type {
  ModelAvailability,
  OperationAvailability,
} from "../src/contracts/generated.ts";
import type { ModelConfig } from "../src/backend/rules.ts";
import { setActiveLocale } from "../src/i18n/messages.ts";

const clockAt = (now: number): AvailabilityClock => ({
  wallNow: () => now,
  monotonicNow: () => now,
});

test("a transport failure permits a matching successful retry without reloading the directory", () => {
  const value = observation([operation("text_response")]);
  const failed = failedAvailability(value);
  const configured = model(failed);
  assert.equal(
    availabilityBlocker(configured, "text_response", clockAt(2000)),
    null,
  );
  assert.equal(failed.status, "unknown");
  assert.equal(availabilityMatchesModel(configured, value), true);
  assert.equal(value.status, "unavailable");
});

const operation = (
  profile: string,
  changes: Partial<OperationAvailability> = {},
): OperationAvailability => ({
  operation: "chat",
  profile,
  method: "POST",
  path: "/v1/chat/completions",
  output: "text",
  status: "unavailable",
  reasonCode: "execution_paused",
  checkedAt: 1000,
  expiresAt: 6000,
  inputDetails: [],
  ...changes,
});
const observation = (
  operations: OperationAvailability[],
): ModelAvailability => ({
  configId: "saved",
  modelId: "served",
  identity: "private-identity-digest",
  autoCheck: true,
  status: "unavailable",
  reasonCode: "execution_paused",
  checkedAt: 1000,
  expiresAt: 6000,
  revision: "one",
  operations,
});
const model = (availability?: ModelAvailability): ModelConfig => ({
  id: "saved",
  providerId: "service",
  kind: "agent",
  url: "http://localhost:8100/v1",
  modelId: "served",
  connectionType: "self_hosted",
  protocol: "openai",
  authMode: "none",
  availability,
  inputRules: {
    profile: "chat",
    allowedKinds: ["text"],
    maxImages: 0,
    maxVideos: 0,
    maxAudios: 0,
    videoModes: [],
  },
});

test("a paused observation expires independently of a 30-second declaration", () => {
  const value = observation([
    operation("text_response"),
    operation("image_response", {
      reasonCode: "profile_unsupported",
      expiresAt: 31000,
    }),
  ]);
  assert.equal(
    currentAvailability(value, clockAt(5999)).operations[0].status,
    "unavailable",
  );
  const expired = currentAvailability(value, clockAt(6000));
  assert.equal(expired.operations[0].status, "unknown");
  assert.equal(expired.operations[1].status, "unavailable");
  assert.equal(
    value.operations[0].status,
    "unavailable",
    "the input observation is immutable",
  );
  assert.equal(
    currentAvailability(value, clockAt(31000)).operations[1].status,
    "unknown",
  );
});

test("unknown observations and missing profiles keep manual configuration usable", () => {
  assert.equal(
    availabilityBlocker(model(), "text_response", clockAt(2000)),
    null,
  );
  assert.equal(
    availabilityBlocker(
      model(observation([operation("image_response")])),
      "text_response",
      clockAt(2000),
    ),
    null,
  );
  assert.equal(
    availabilityBlocker(
      model(observation([operation("text_response", { status: "unknown" })])),
      "text_response",
      clockAt(2000),
    ),
    null,
  );
});

test("explicit text denial blocks text without blocking a music profile", () => {
  setActiveLocale("en-US");
  const configured = model(
    observation([
      operation("text_response", { reasonCode: "profile_unsupported" }),
      operation("lyrics_to_music", {
        status: "available",
        reasonCode: "supported",
      }),
    ]),
  );
  assert.match(
    availabilityBlocker(configured, "text_response", clockAt(2000))!,
    /Not supported/,
  );
  assert.equal(
    availabilityBlocker(configured, "lyrics_to_music", clockAt(2000)),
    null,
  );
  assert.equal(
    availabilityBlocker(configured, "text_response", clockAt(6000)),
    null,
  );
});

test("a failed refreshed observation cannot reuse the earlier paused denial", () => {
  const configured = model(observation([operation("text_response")]));
  assert.ok(availabilityBlocker(configured, "text_response", clockAt(2000)));
  assert.equal(
    availabilityBlocker(
      { ...configured, availability: undefined },
      "text_response",
      clockAt(2000),
    ),
    null,
  );
});

test("expiry scheduling includes each operation and stops after all observations expire", () => {
  const configured = model(
    observation([
      operation("text_response"),
      operation("image_response", { expiresAt: 31000 }),
    ]),
  );
  assert.equal(nextAvailabilityExpiry([configured], clockAt(2000)), 6000);
  assert.equal(nextAvailabilityExpiry([configured], clockAt(6000)), 31000);
  assert.equal(nextAvailabilityExpiry([configured], clockAt(31000)), null);
});

test("connection changes invalidate observations while observation updates preserve identity", () => {
  const configured = model();
  const identity = availabilityModelKey(configured);
  for (const patch of [
    { providerId: "other" },
    { modelId: "other" },
    { url: "http://localhost:8200/v1" },
    { proxyMode: "direct" as const },
    { capabilityAutoCheck: false },
    { inputModalities: ["text", "image"] as ("text" | "image")[] },
    {
      videoCapabilities: {
        outputs: [{ resolution: "720p", durations: [5] }],
        defaultResolution: "720p",
        defaultDuration: 5,
        dimensionStep: 16 as const,
      },
    },
  ]) {
    assert.notEqual(
      availabilityModelKey({ ...configured, ...patch }),
      identity,
    );
  }
  assert.equal(
    availabilityModelKey({ ...configured, availability: observation([]) }),
    identity,
  );
});

test("rejection reasons follow the current language without altering business identity", () => {
  const configured = model(observation([operation("text_response")]));
  setActiveLocale("zh-CN");
  assert.match(
    availabilityBlocker(configured, "text_response", clockAt(2000))!,
    /暂停/,
  );
  setActiveLocale("en-US");
  assert.match(
    availabilityBlocker(configured, "text_response", clockAt(2000))!,
    /paused/,
  );
  assert.equal(configured.modelId, "served");
});

test("wall-clock rollback and repeated responses do not renew a received pause", () => {
  let wall = 1000,
    elapsed = 0;
  const timing: AvailabilityClock = {
    wallNow: () => wall,
    monotonicNow: () => elapsed,
  };
  const original = receiveAvailability(
    observation([operation("text_response")]),
    timing,
  );
  assert.equal(availabilityDelay(original, timing), 5000);
  wall = -60_000;
  elapsed = 4999;
  const duplicate = receiveAvailability(structuredClone(original), timing);
  assert.equal(availabilityDelay(duplicate, timing), 1);
  assert.equal(currentAvailability(duplicate, timing).status, "unavailable");
  elapsed = 5000;
  assert.equal(currentAvailability(duplicate, timing).status, "unknown");
  assert.equal(availabilityDelay(duplicate, timing), null);
  assert.equal(
    availabilityBlocker(model(duplicate), "text_response", timing),
    null,
  );
  assert.equal(original.operations[0].status, "unavailable");
});

test("wall-clock advances do not shorten the already received lifetime", () => {
  let wall = 1000,
    elapsed = 0;
  const timing: AvailabilityClock = {
    wallNow: () => wall,
    monotonicNow: () => elapsed,
  };
  const value = receiveAvailability(
    observation([operation("text_response")]),
    timing,
  );
  wall = 100_000;
  elapsed = 1000;
  assert.equal(currentAvailability(value, timing).status, "unavailable");
  assert.equal(availabilityDelay(value, timing), 4000);
  assert.equal(nextAvailabilityExpiry([model(value)], timing), 104_000);
});

test("a matching model ID cannot authorize observations for a changed opaque identity", () => {
  const expected = observation([operation("text_response")]);
  const configured = model(expected);
  assert.equal(availabilityMatchesModel(configured, expected), true);
  assert.equal(
    availabilityMatchesModel(configured, {
      ...expected,
      identity: "changed-account-or-url",
    }),
    false,
  );
  assert.equal(
    availabilityMatchesModel(configured, {
      ...expected,
      configId: "other-service",
    }),
    false,
  );
  assert.equal(availabilityMatchesModel(model(), expected), false);
  assert.equal(
    availabilityMatchesModel(model(), expected, expected.identity),
    true,
  );
});

test("pause expires before its retained declaration, without renewing either observation", () => {
  let now = 1000;
  const timing = { wallNow: () => now, monotonicNow: () => now };
  const value = observation([
    operation("image_to_image", {
      declaration: {
        status: "available",
        reasonCode: "supported",
        checkedAt: 1000,
        expiresAt: 31000,
      },
      execution: {
        state: "paused",
        scope: "deployment",
        checkedAt: 1000,
        expiresAt: 6000,
      },
      inputDetails: [
        {
          name: "image",
          source: "service",
          support: "supported",
          minCount: 1,
          maxCount: 2,
          min: null,
          max: null,
          multipleOf: null,
          values: null,
        },
      ],
    }),
  ]);
  receiveAvailability(value, timing);
  assert.equal(
    availabilityBlocker(model(value), "image_to_image", timing),
    "Service paused",
  );
  assert.equal(
    availabilityInputLimit(model(value), "image_to_image", "image", timing),
    2,
  );
  now = 6000;
  const replay = receiveAvailability(structuredClone(value), timing);
  assert.equal(
    currentAvailability(replay, timing).operations[0].status,
    "available",
  );
  assert.equal(
    currentAvailability(replay, timing).operations[0].execution?.state,
    "unknown",
  );
  assert.equal(
    availabilityBlocker(model(replay), "image_to_image", timing),
    null,
  );
  assert.equal(availabilityDelay(replay, timing), 25000);
  now = 31000;
  assert.equal(
    currentAvailability(replay, timing).operations[0].reasonCode,
    "observation_expired",
  );
  assert.equal(
    availabilityInputLimit(model(replay), "image_to_image", "image", timing),
    null,
  );
  assert.equal(value.operations[0].status, "unavailable");
});

test("service limits disappear on failure and do not include application constraints", () => {
  const detail = {
    name: "image",
    source: "service" as const,
    support: "supported" as const,
    minCount: 1,
    maxCount: 3,
    min: null,
    max: null,
    multipleOf: null,
    values: null,
  };
  const value = observation([
    operation("image_to_image", {
      status: "available",
      reasonCode: "supported",
      declaration: {
        status: "available",
        reasonCode: "supported",
        checkedAt: 1000,
        expiresAt: 31000,
      },
      inputDetails: [detail, { ...detail, source: "application", maxCount: 1 }],
    }),
  ]);
  const timing = clockAt(2000);
  assert.equal(
    availabilityInputLimit(model(value), "image_to_image", "image", timing),
    3,
  );
  assert.equal(
    availabilityInputLimit(model(value), "image_to_image", "video", timing),
    null,
  );
  assert.equal(
    availabilityInputLimit(
      model(failedAvailability(value)),
      "image_to_image",
      "image",
      timing,
    ),
    null,
  );
  assert.equal(
    failedAvailability(value).operations[0].declaration?.status,
    "unknown",
  );
});
