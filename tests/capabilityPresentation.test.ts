import assert from "node:assert/strict";
import test from "node:test";
import {
  availabilityCardDetails,
  availabilityNotice,
  availabilityRow,
} from "../src/canvas/availabilityPresentation.ts";
import { assistantToolText } from "../src/canvas/assistantToolText.ts";
import { toolTaskError } from "../src/canvas/toolTaskText.ts";
import { toolReasonText } from "../src/canvas/toolReasonText.ts";
import { setActiveLocale } from "../src/i18n/messages.ts";
import { availabilityReason } from "../src/backend/availability.ts";
import type {
  ModelAvailability,
  OperationAvailability,
} from "../src/contracts/generated.ts";

const operation = (
  profile: string,
  reasonCode = "supported",
): OperationAvailability => ({
  operation: "image_edit",
  profile,
  path: "/v1/images/edits",
  method: "POST",
  output: "image",
  status: reasonCode === "supported" ? "available" : "unknown",
  reasonCode,
  checkedAt: null,
  expiresAt: null,
  inputDetails: [],
});
const availability = (
  operations: OperationAvailability[],
): ModelAvailability => ({
  configId: "one",
  modelId: "served",
  identity: "one",
  autoCheck: false,
  status: "unknown",
  reasonCode: "mixed_operations",
  checkedAt: null,
  expiresAt: null,
  revision: "test",
  operations,
});

test("normal cards have no aggregate summary; shared expiry is presented once", () => {
  setActiveLocale("en-US");
  assert.equal(
    availabilityNotice(availability([operation("text_to_image")])),
    null,
  );
  const stale = operation("image_to_image", "observation_expired");
  const notice = availabilityNotice(
    availability([stale, { ...stale, profile: "images_to_image" }]),
  );
  assert.equal(notice, "observation_expired");
  assert.deepEqual(availabilityRow(stale, notice), {
    status: "unknown",
    muted: true,
    text: "—",
  });
  assert.equal(
    availabilityRow(operation("image_to_image", "input_count_unknown"), null)
      .text,
    "Image count not confirmed",
  );
});

test("a shared failed check covers secondary unknown projections", () => {
  for (const reason of [
    "not_checked",
    "connection_failed",
    "authentication_failed",
    "protocol_unavailable",
    "query_failed",
    "observation_expired",
  ]) {
    const multi = operation("images_to_image", "input_count_unknown");
    const value = {
      ...availability([
        operation("text_to_image", reason),
        operation("image_to_image", reason),
        multi,
      ]),
      reasonCode: reason,
    };
    const notice = availabilityNotice(value);
    assert.equal(notice, reason);
    assert.deepEqual(availabilityRow(multi, notice), {
      status: "unknown",
      muted: true,
      text: "—",
    });
  }
  for (const [locale, expected] of [
    [
      "zh-CN",
      [
        "检查结果已过期，请刷新",
        "无法连接服务，请检查地址",
        "认证失败，请检查密钥",
        "不支持",
        "待确认",
      ],
    ],
    [
      "en-US",
      [
        "Results expired. Refresh to check again.",
        "Cannot connect. Check the service URL.",
        "Authentication failed. Check the API key.",
        "Not supported",
        "Unknown",
      ],
    ],
  ] as const) {
    setActiveLocale(locale);
    assert.deepEqual(
      [
        "observation_expired",
        "connection_failed",
        "authentication_failed",
        "profile_unsupported",
        "mixed_operations",
      ].map(availabilityReason),
      expected,
    );
  }
});

test("shared input requirements appear once, differing route limits keep their scope", () => {
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
  const first = {
    ...operation("image_to_image"),
    inputDetails: [detail, { ...detail, name: "private_unknown_field" }],
  };
  const second = { ...operation("images_to_image"), inputDetails: [detail] };
  assert.equal(availabilityCardDetails([first, second]).length, 1);
  assert.equal(availabilityCardDetails([first, second])[0].scope, undefined);
  assert.equal(
    availabilityCardDetails([
      first,
      { ...second, inputDetails: [{ ...detail, maxCount: 4 }] },
    ]).length,
    2,
  );
  assert.match(
    availabilityCardDetails([
      first,
      { ...second, inputDetails: [{ ...detail, maxCount: 4 }] },
    ])[0].scope!,
    /Single-image/,
  );
  setActiveLocale("zh-CN");
  assert.equal(availabilityCardDetails([first])[0].label, "图片");
  assert.equal(availabilityCardDetails([first])[0].source, "服务声明");
});

test("tools and assistant retain concrete capability and selection failures in either language", () => {
  const cases = [
    ["该模型不支持文字回复。", "This model does not support text replies."],
    ["服务未开放图片编辑。", "The service has not enabled image editing."],
    ["最多支持 2 张图片，当前为 3 张。", "Up to 2 images; 3 added."],
    ["该工具需要 2 张来源图片。", "This tool requires 2 source images."],
    [
      "图片宽度不符合服务要求。",
      "Image width does not meet the service requirements.",
    ],
    [
      "选区与图片的尺寸不一致。",
      "The selection and image dimensions must match.",
    ],
    ["请提供图片或音频。", "Provide images or audio."],
  ];
  for (const [zh, en] of cases) {
    setActiveLocale("en-US");
    assert.equal(
      assistantToolText(zh, undefined, "capability_unavailable"),
      en,
    );
    assert.equal(toolReasonText(zh), en);
    assert.equal(toolTaskError(zh), en);
    setActiveLocale("zh-CN");
    assert.equal(
      assistantToolText(zh, undefined, "capability_unavailable"),
      zh,
    );
    assert.equal(toolTaskError(zh), zh);
  }
});
