/** Bilingual UI regression for a terminal finish-write failure.
 * Uses the assistant fixture and a mocked SSE terminal response; no model calls.
 */
import assert from "node:assert/strict";
import { launchBrowser } from "./engine.mjs";

const base = process.env.CREATION_WEB_URL ?? "http://127.0.0.1:5179";
const headers = {
  "X-OpenDirector-Request": "1",
  "X-OpenDirector-Session": crypto.randomUUID(),
  "Content-Type": "application/json",
};

async function api(path, body) {
  const response = await fetch(base + "/api" + path, {
    headers,
    ...(body ? { method: "POST", body: JSON.stringify(body) } : {}),
  });
  assert.ok(response.ok, await response.clone().text());
  return response.json();
}

async function until(read, matches, label) {
  const deadline = Date.now() + 15000;
  while (true) {
    const value = await read();
    if (matches(value)) return value;
    assert.ok(Date.now() < deadline, label);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const health = await api("/creation-test-health");
assert.equal(health.isolated, true);
assert.equal(health.assistantFixture, true);

const browser = await launchBrowser();
try {
  for (const locale of ["en-US", "zh-CN"]) {
    const projectId = crypto.randomUUID();
    await api("/creation/projects/" + projectId + "/commands", {
      type: "project.create",
      projectId,
      commandId: crypto.randomUUID(),
      payload: { name: "Finish failure " + locale },
    });

    const page = await browser.newPage({
      locale,
      viewport: { width: 1440, height: 1000 },
    });
    page.setDefaultTimeout(15000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript((id, selectedLocale) => {
      localStorage.setItem("opendirector.modelSetup.v1", "dismissed");
      localStorage.setItem("opendirector.locale.v1", selectedLocale);
      localStorage.setItem("opendirector.lastUnifiedFilesystemProject", id);
    }, projectId, locale);
    await page.route(/\/assistant\/runtimes(?:\?.*)?$/, (route) =>
      route.fulfill({
        json: [{
          id: "default",
          label: "Default",
          group: "default",
          modelSource: "settings",
          available: true,
          status: "ready",
          modelOverride: false,
          supportsSkills: true,
        }],
      }),
    );

    await page.goto(base);
    await page.locator(".cw-save-status .saved").waitFor({ state: "attached" });
    const panel = page.locator("#canvas-assistant");
    if (!(await panel.isVisible())) await page.locator(".cw-chat-button").click();
    const editor = panel.locator('[contenteditable="true"]').first();
    await editor.waitFor();
    const conversationPath = "/creation/projects/" + projectId + "/assistant";
    await until(
      () => api(conversationPath),
      (value) => !!value.modelSelections.agent,
      "default agent model must be ready",
    );
    const before = await api(conversationPath);

    const errorText = locale === "en-US"
      ? "The reply could not be saved. Check the backend log."
      : "回复未能保存，请检查后端日志。";
    const partialText = locale === "en-US"
      ? "Partial reply before the failed save"
      : "断盘前的部分回复";

    await page.route(/\/assistant\/turns$/, async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      const { id, text: userText } = route.request().postDataJSON();
      const started = {
        ...before,
        messages: [
          ...before.messages,
          {
            id: crypto.randomUUID(),
            role: "user",
            text: userText,
            status: "complete",
          },
          { id, role: "assistant", text: "", status: "streaming" },
        ],
      };
      return route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: [
          { type: "start", conversation: started },
          { type: "delta", text: partialText },
          {
            type: "end",
            turnId: id,
            nextTurnId: null,
            conversation: null,
            error: errorText,
          },
        ].map((event) => "data: " + JSON.stringify(event) + "\n\n").join(""),
      });
    });

    await editor.fill(locale === "en-US" ? "Finish write failure" : "写盘失败");
    await panel.locator(".cw-assistant-send").click();
    await panel.getByRole("alert").filter({ hasText: errorText }).waitFor();
    await panel.getByText(partialText, { exact: true }).waitFor();

    const failedReply = panel
      .locator(".cw-assistant-message.is-assistant")
      .filter({ hasText: partialText });
    assert.equal(await failedReply.count(), 1);
    assert.equal(
      await failedReply.locator('.cw-chat-progress[role="status"]').count(),
      0,
      "a terminal end without a saved conversation must stop the message-level progress indicator",
    );
    assert.equal(
      await panel.locator(".cw-assistant-send").getAttribute("type"),
      "submit",
      "the global Stop control must be replaced by the normal Send control",
    );

    const screenshotPath = process.env[
      locale === "en-US"
        ? "ASSISTANT_FINISH_FAILURE_SCREENSHOT_EN"
        : "ASSISTANT_FINISH_FAILURE_SCREENSHOT_ZH"
    ] ?? "/tmp/opendirector-finish-failure-" + locale + ".png";
    await page.screenshot({ path: screenshotPath });
    await page.unroute(/\/assistant\/turns$/);
    assert.deepEqual(errors, []);
    console.log("PASS finish failure terminal UI: " + locale);
    await page.close();
  }
} finally {
  await browser.close();
}
