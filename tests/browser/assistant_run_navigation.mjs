/** Switching projects while the Agent replies only detaches the view: the run
 * keeps going, the reply resumes on return, and only Stop stops it (#81).
 * Start creation_server.py with --assistant-fixture before running this check.
 */
import assert from "node:assert/strict";
import { launchBrowser } from "./engine.mjs";

const base = process.env.CREATION_WEB_URL ?? "http://127.0.0.1:5179";
const headers = {
  "X-OpenDirector-Request": "1",
  "X-OpenDirector-Session": crypto.randomUUID(),
};
async function api(path, value) {
  const response = await fetch(base + "/api" + path, {
    headers: { ...headers, "Content-Type": "application/json" },
    ...(value ? { method: "POST", body: JSON.stringify(value) } : {}),
  });
  assert.ok(response.ok, await response.clone().text());
  return response.json();
}
async function until(read, matches, label) {
  const deadline = Date.now() + 15000;
  while (true) {
    const value = await read();
    if (matches(value)) return value;
    assert.ok(Date.now() < deadline, `${label}: ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
const health = await api("/creation-test-health");
assert.equal(health.isolated, true);
assert.equal(health.assistantFixture, true);
const create = async (name) => {
  const projectId = crypto.randomUUID();
  await api(`/creation/projects/${projectId}/commands`, {
    type: "project.create",
    projectId,
    commandId: crypto.randomUUID(),
    payload: { name },
  });
  return projectId;
};
const tag = crypto.randomUUID().slice(0, 8);
const nameA = `导航 A ${tag}`,
  nameB = `导航 B ${tag}`;
const projectA = await create(nameA);
await create(nameB);
const path = `/creation/projects/${projectA}/assistant`;

const browser = await launchBrowser();
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const stops = [];
  page.on("request", (request) => {
    if (/\/assistant\/turns\/[^/]+\/stop$/.test(request.url()))
      stops.push(request.url());
  });
  await page.route(/\/assistant\/runtimes(?:\?.*)?$/, (route) =>
    route.fulfill({
      json: [
        {
          id: "default",
          label: "Default",
          group: "default",
          modelSource: "settings",
          available: true,
          status: "ready",
          modelOverride: false,
          supportsSkills: true,
        },
      ],
    }),
  );
  await page.addInitScript((id) => {
    localStorage.setItem("opendirector.lastUnifiedFilesystemProject", id);
    localStorage.setItem("opendirector.modelSetup.v1", "dismissed");
  }, projectA);
  await page.goto(base);
  await page
    .getByText("已保存到本机", { exact: true })
    .waitFor({ state: "attached" });
  const panel = page.getByRole("complementary", {
    name: "AI 对话",
    exact: true,
  });
  const editor = panel.getByRole("textbox", { name: "消息内容", exact: true });
  const show = async () => {
    if (!(await panel.isVisible()))
      await page
        .getByRole("button", { name: "与 AI 对话", exact: true })
        .click();
    await editor.waitFor();
  };
  const switchTo = async (name) => {
    await page.getByRole("button", { name: "切换项目", exact: true }).click();
    await page.getByRole("menuitemradio", { name, exact: true }).click();
  };
  await show();
  await until(
    () => api(path),
    (value) => !!value.modelSelections.agent,
    "Default model must be saved",
  );

  // Hold the fixture reply after its first sentence.
  await api("/creation-test-assistant-gate", { open: false });
  await editor.fill("海边短片");
  await panel.getByRole("button", { name: "发送消息", exact: true }).click();
  await panel.getByText("已收到创作要求。", { exact: false }).waitFor();
  assert.equal((await api(path)).messages.at(-1).status, "streaming");

  // Leaving the project does not stop the run.
  await switchTo(nameB);
  await until(
    () =>
      page.evaluate(() =>
        localStorage.getItem("opendirector.lastUnifiedFilesystemProject"),
      ),
    (id) => id && id !== projectA,
    "Project B must open",
  );
  await page.waitForTimeout(1000);
  const away = await api(path);
  assert.equal(away.messages.at(-1).status, "streaming", "reply after leaving");
  assert.ok(away.activeTurnId, "the run continues while away");

  // Returning re-attaches: the reply is still running, not stopped.
  await switchTo(nameA);
  await show();
  await panel.getByText("已收到创作要求。", { exact: false }).waitFor();
  await panel.getByRole("button", { name: "停止回复", exact: true }).waitFor();
  assert.equal(await panel.getByText("已停止回复").count(), 0);

  // The re-attached view receives the rest of the reply.
  await api("/creation-test-assistant-gate", { open: true });
  await panel
    .getByText("已收到创作要求。这是隔离测试回复。", { exact: true })
    .waitFor();
  const done = await until(
    () => api(path),
    (value) => value.messages.at(-1).status === "complete",
    "Reply must complete",
  );
  assert.equal(done.activeTurnId, undefined);
  assert.deepEqual(stops, [], "navigation must not call stop");

  // An explicit stop after leaving and returning still stops the run.
  await api("/creation-test-assistant-gate", { open: false });
  await editor.fill("森林短片");
  await panel.getByRole("button", { name: "发送消息", exact: true }).click();
  await until(
    () => api(path),
    (value) =>
      value.messages.length === 4 &&
      value.messages.at(-1).status === "streaming",
    "Second reply must start",
  );
  await switchTo(nameB);
  await page.waitForTimeout(800);
  await switchTo(nameA);
  await show();
  const stop = panel.getByRole("button", { name: "停止回复", exact: true });
  await until(() => stop.isEnabled(), Boolean, "Stop must be available");
  await stop.click();
  const stopped = await until(
    () => api(path),
    (value) => value.messages.at(-1).status === "stopped",
    "Explicit stop must persist",
  );
  assert.equal(stopped.activeTurnId, undefined);
  await panel.getByText("已停止回复").waitFor();
  assert.deepEqual(errors, []);
  console.log("assistant run navigation ok");
} finally {
  await api("/creation-test-assistant-gate", { open: true }).catch(() => {});
  await browser.close();
}
