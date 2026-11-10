import test from "node:test";
import assert from "node:assert/strict";
import type { GenerationFailure } from "../src/contracts/generated.ts";
import { generationFailureMessage } from "../src/canvas/generationFailureText.ts";
import { setActiveLocale } from "../src/i18n/messages.ts";

function failure(patch: Partial<GenerationFailure>): GenerationFailure {
  return {
    category: "input",
    stage: "submit",
    message: "生成服务拒绝了输入内容或参数。",
    suggestion: "请检查生成要求、参数和模型支持范围。",
    providerCode: null,
    requestId: null,
    httpStatus: 400,
    providerStatus: null,
    ...patch,
  };
}

test("known persisted failures are translated without showing backend Chinese", () => {
  setActiveLocale("en-US");
  assert.equal(
    generationFailureMessage(failure({})),
    "The generation service rejected the input or parameters.",
  );
  assert.equal(
    generationFailureMessage(failure({ message: "供应商任务已取消。" })),
    "The provider task was cancelled.",
  );
  setActiveLocale("zh-CN");
  assert.equal(
    generationFailureMessage(failure({})),
    "生成服务拒绝了输入内容或参数。",
  );
});

test("new provider messages fall back to category, stage and status", () => {
  setActiveLocale("en-US");
  assert.equal(
    generationFailureMessage(
      failure({ category: "authentication", message: "provider-defined text" }),
    ),
    "Generation service authentication failed. Check the API key in settings.",
  );
  assert.equal(
    generationFailureMessage(
      failure({
        category: "temporary",
        stage: "download",
        message: "new provider text",
      }),
    ),
    "The generated result could not be downloaded.",
  );
  assert.equal(
    generationFailureMessage(
      failure({
        category: "provider",
        stage: "cancel",
        httpStatus: 404,
        message: "new provider text",
      }),
    ),
    "The provider could not find this task.",
  );
  setActiveLocale("zh-CN");
});

test("Kling content-policy rejection remains explicit in both languages", () => {
  const value = failure({ providerCode: "1301", message: "供应商判定提示词或参考图片违反内容政策，已拒绝生成。" });
  setActiveLocale("en-US");
  assert.match(generationFailureMessage(value), /content policy/);
  setActiveLocale("zh-CN");
  assert.match(generationFailureMessage(value), /内容政策/);
});

test("submission unknown failures remain explicit", () => {
  setActiveLocale("en-US");
  assert.equal(
    generationFailureMessage(
      failure({
        category: "submission_unknown",
        stage: "submit",
        httpStatus: null,
        message: "生成请求的提交结果不明。",
      }),
    ),
    "The submission result is unknown. Check with the provider before retrying.",
  );
  setActiveLocale("zh-CN");
});

for (const message of [
  "当前账户没有调用该模型的权限。",
  "生成服务拒绝了访问请求。",
]) {
  test(`403 access checks are useful in both languages for ${message}`, () => {
    try {
      const details = failure({
        category: "permission",
        httpStatus: 403,
        providerCode: "permission_error",
        message,
      });
      setActiveLocale("en-US");
      const english = generationFailureMessage(details);
      assert.match(english, /denied access/i);
      assert.match(english, /API key/i);
      assert.match(english, /permissions/i);
      assert.match(english, /security polic/i);
      assert.doesNotMatch(english, /[\u3400-\u9fff]/);
      setActiveLocale("zh-CN");
      const chinese = generationFailureMessage(details);
      assert.match(chinese, /拒绝了访问请求/);
      assert.match(chinese, /API Key/);
      assert.match(chinese, /权限/);
      assert.match(chinese, /安全策略/);
    } finally {
      setActiveLocale("zh-CN");
    }
  });
}

test("voice_not_found identifies the voice before generic 404 or input failures", () => {
  try {
    setActiveLocale("en-US");
    const english = "The voice was not found or is unavailable to this account. Select an available voice in the voice library.";
    const chinese = "该音色不存在或当前账户无权使用，请在音色库重新选择可用音色。";
    // MOSS reports a voice_not_found code; Zhipu reports code 1214 with this backend message.
    const zhipu = failure({ providerCode: "1214", httpStatus: 400, category: "input", message: "所选音色不存在或不可用。" });
    assert.equal(generationFailureMessage(failure({ providerCode: "voice_not_found", httpStatus: 404 })), english);
    assert.equal(generationFailureMessage(zhipu), english);
    setActiveLocale("zh-CN");
    assert.equal(generationFailureMessage(failure({ providerCode: "voice_not_found", httpStatus: 404 })), chinese);
    assert.equal(generationFailureMessage(zhipu), chinese);
  } finally {
    setActiveLocale("zh-CN");
  }
});

test("provider moderation verdicts are explained in both languages", () => {
  const moderated = (message: string) =>
    failure({ stage: "poll", httpStatus: 200, providerStatus: "failed", providerCode: "1027", message });
  setActiveLocale("en-US");
  assert.match(
    generationFailureMessage(moderated("供应商判定输入内容涉及敏感信息，已拒绝生成。")),
    /flagged the input as sensitive/,
  );
  assert.match(
    generationFailureMessage(moderated("供应商判定生成内容涉及敏感信息，已拒绝交付。")),
    /flagged the generated content as sensitive/,
  );
  setActiveLocale("zh-CN");
  assert.match(
    generationFailureMessage(moderated("供应商判定生成内容涉及敏感信息，已拒绝交付。")),
    /生成内容涉及敏感信息/,
  );
});
