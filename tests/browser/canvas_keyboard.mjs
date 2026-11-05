import assert from "node:assert/strict";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright-core");
const base = process.env.CREATION_WEB_URL ?? "http://127.0.0.1:8019";
const headers = { "X-OpenDirector-Request": "1", "Content-Type": "application/json" };
const health = await fetch(base + "/api/creation-test-health", { headers });
assert.equal((await health.json()).isolated, true);

const id = crypto.randomUUID();
const project = base + `/api/creation/projects/${id}`;
const created = await fetch(project + "/commands", {
  headers,
  method: "POST",
  body: JSON.stringify({
    projectId: id, commandId: crypto.randomUUID(), type: "project.create",
    payload: { name: `Canvas keyboard ${id}` },
  }),
});
assert.ok(created.ok);

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  // Skip the first-run model setup welcome; it covers the canvas.
  await page.addInitScript(() =>
    localStorage.setItem("opendirector.modelSetup.v1", "dismissed"),
  );
  await page.goto(`${base}/ai-tool/ai-canvas/${id}`);
  const nodes = page.locator(".react-flow__node");
  const selected = page.locator(".react-flow__node.selected");
  const addVideo = page.getByRole("button", { name: "添加视频", exact: true });
  await addVideo.click();
  await selected.waitFor();
  const source = await selected.getAttribute("data-id");
  await page.keyboard.press("Control+c");
  await page.keyboard.press("Control+v");
  await page.waitForFunction(() => document.querySelectorAll(".react-flow__node").length === 2);
  const pasted = await selected.getAttribute("data-id");
  assert.notEqual(pasted, source);
  await page.keyboard.press("Delete");
  await page.waitForFunction(() => document.querySelectorAll(".react-flow__node").length === 1);
  assert.equal(await nodes.first().getAttribute("data-id"), source);

  await addVideo.click();
  await selected.waitFor();
  await page.keyboard.press("Backspace");
  await page.waitForFunction(() => document.querySelectorAll(".react-flow__node").length === 1);
  await page.waitForFunction(async ({ project, headers, source, pasted }) => {
    const response = await fetch(project, { headers });
    const snapshot = await response.json();
    const visible = snapshot.canvasItems.filter(item => item.visible);
    return visible.length === 1 && visible[0].id === source
      && snapshot.canvasItems.some(item => item.id === pasted && !item.visible);
  }, { project, headers, source, pasted }, { polling: 250 });
  await page.getByText("已保存到本机", { exact: true }).waitFor();
  await nodes.first().click();
  const prompt = page.getByRole("textbox", { name: "生成提示词", exact: true });
  await prompt.waitFor();
  assert.equal(await prompt.evaluate(el => el === document.activeElement), false);
  await prompt.click();
  await page.keyboard.type("Prompt");
  await page.keyboard.press("Backspace");
  assert.equal((await prompt.innerText()).replaceAll("\u200b", ""), "Promp");
  assert.equal(await nodes.count(), 1);
  console.log("Newly created and pasted nodes respond to canvas shortcuts and save correctly.");
} finally {
  await browser.close();
}
