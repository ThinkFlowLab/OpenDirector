/**
 * Isolated UI regression: one shortcut registry drives the tooltips, the help
 * dialog and the handlers, and the app-wide keys stay out of text fields and
 * open dialogs.
 *
 * The fixture is a plain project; nothing here generates media.
 */
import assert from "node:assert/strict";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright-core");
const base = process.env.CREATION_WEB_URL ?? "http://127.0.0.1:5179";
const api = process.env.CREATION_API_URL ?? "http://127.0.0.1:8019";

async function call(path, body) {
  const response = await fetch(api + path, {
    headers: {
      "X-OpenDirector-Request": "1",
      "Content-Type": "application/json",
    },
    ...(body ? { method: "POST", body: JSON.stringify(body) } : {}),
  });
  assert.ok(response.ok, `${response.status}: ${await response.clone().text()}`);
  return response.json();
}

assert.equal((await call("/api/creation-test-health")).isolated, true);

const projectId = crypto.randomUUID();
await call(`/api/creation/projects/${projectId}/commands`, {
  projectId,
  commandId: crypto.randomUUID(),
  type: "project.create",
  payload: { name: `Shortcuts ${projectId.slice(0, 8)}` },
});

const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  args: ["--no-sandbox"],
});
try {
  const page = await browser.newPage({
    locale: "zh-CN",
    viewport: { width: 1500, height: 1000 },
  });
  await page.addInitScript(() => {
    if (!new URLSearchParams(location.search).has("setup")) {
      localStorage.setItem("opendirector.modelSetup.v1", "dismissed");
    }
  });
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto(`${base}/ai-tool/ai-canvas/${projectId}`);
  await page.getByText("已保存到本机", { exact: true }).waitFor();

  // 1. Hovering a control names the same keys the handler listens for.
  const settingsButton = page.getByRole("button", { name: "设置", exact: true });
  await settingsButton.hover();
  const tooltip = page.getByRole("tooltip");
  await tooltip.waitFor();
  assert.equal(await tooltip.locator("span").innerText(), "设置");
  assert.equal(await tooltip.locator("kbd").innerText(), "Ctrl+,");
  await page.mouse.move(5, 500);
  await tooltip.waitFor({ state: "hidden" });
  assert.equal(
    await settingsButton.getAttribute("aria-keyshortcuts"),
    "Control+, Meta+,",
  );

  // 2. The same key opens the settings dialog, and Escape closes it.
  await page.keyboard.press("Control+Comma");
  const settingsDialog = page.locator("dialog[open], [role=dialog]").first();
  await settingsDialog.waitFor();
  await page.keyboard.press("Escape");
  await settingsDialog.waitFor({ state: "hidden" });

  // 3. A shortcut cannot fire through an open dialog.
  await page.keyboard.press("Control+Comma");
  await settingsDialog.waitFor();
  await page.keyboard.press("Control+k");
  await page.waitForTimeout(300);
  assert.equal(await page.locator(".cw-project-dropdown").count(), 0);
  await page.keyboard.press("Escape");
  await settingsDialog.waitFor({ state: "hidden" });

  // 4. Control+K opens the project menu with the search field focused, and
  //    typing in that field does not toggle the menu closed again.
  await page.keyboard.press("Control+k");
  const dropdown = page.locator(".cw-project-dropdown");
  await dropdown.waitFor();
  const search = dropdown.getByRole("searchbox");
  await search.waitFor();
  assert.equal(
    await page.evaluate(() => document.activeElement?.getAttribute("type")),
    "search",
  );
  await page.keyboard.press("Control+k");
  await page.waitForTimeout(300);
  assert.ok(await dropdown.isVisible());
  await page.keyboard.press("Escape");
  await dropdown.waitFor({ state: "hidden" });

  // 5. The project menu advertises the new-project key on its own row.
  await page.keyboard.press("Control+k");
  const create = page.getByRole("menuitem", { name: /新建画布项目/ });
  await create.waitFor();
  assert.equal(await create.locator("kbd").innerText(), "Ctrl+N");
  assert.equal(
    await create.getAttribute("aria-keyshortcuts"),
    "Control+N Meta+N",
  );
  await page.keyboard.press("Escape");
  await dropdown.waitFor({ state: "hidden" });

  // 6. The help dialog lists the app-wide rows from the same registry.
  await page.getByRole("button", { name: "使用帮助", exact: true }).click();
  const help = page.locator(".cw-help");
  await help.waitFor();
  const helpRows = await help.locator("dl > div").evaluateAll((rows) =>
    rows.map((row) => [
      row.querySelector("dt")?.textContent?.trim() ?? "",
      row.querySelector("dd")?.textContent?.trim() ?? "",
    ]),
  );
  const findRow = (label) => helpRows.find(([name]) => name === label)?.[1];
  assert.equal(findRow("新建画布项目"), "Ctrl+N");
  assert.equal(findRow("切换项目"), "Ctrl+K");
  assert.equal(findRow("设置"), "Ctrl+,");
  assert.equal(findRow("与 AI 对话"), "Ctrl+J");
  assert.equal(findRow("全选画布"), "Ctrl+A");
  assert.equal(findRow("撤销"), "Ctrl+Z");
  assert.equal(findRow("重做"), "Ctrl+Shift+Z");
  // Gestures keep their prose rows; nothing is listed twice.
  assert.equal(findRow("平移画布"), "滚动 / 空格＋拖动");
  assert.equal(new Set(helpRows.map(([name]) => name)).size, helpRows.length);

  // 7. English shows the same keys with English labels.
  await page.keyboard.press("Escape");
  await help.waitFor({ state: "hidden" });
  await page.evaluate(() => localStorage.setItem("opendirector.locale.v1", "en-US"));
  await page.reload();
  await page.getByText("Saved on this device", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Help", exact: true }).click();
  const englishHelp = page.locator(".cw-help");
  await englishHelp.waitFor();
  const englishRows = await englishHelp.locator("dl > div").evaluateAll((rows) =>
    rows.map((row) => [
      row.querySelector("dt")?.textContent?.trim() ?? "",
      row.querySelector("dd")?.textContent?.trim() ?? "",
    ]),
  );
  const findEnglishRow = (label) =>
    englishRows.find(([name]) => name === label)?.[1];
  assert.equal(findEnglishRow("New canvas project"), "Ctrl+N");
  assert.equal(findEnglishRow("Switch project"), "Ctrl+K");
  assert.equal(findEnglishRow("Settings"), "Ctrl+,");
  assert.equal(findEnglishRow("Chat with AI"), "Ctrl+J");
  assert.equal(findEnglishRow("Undo"), "Ctrl+Z");
  assert.equal(findEnglishRow("Pan canvas"), "Scroll / Space + drag");

  assert.deepEqual(errors, []);

  // Chromium inside the desktop shell has no browser-level shortcut table, so
  // every registry entry reaches `useAppShortcuts` unchanged. The packaged app
  // therefore needs no reserved keys or IPC path of its own.

} finally {
  await browser.close();
}
