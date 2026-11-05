/** Isolated UI regression: missing models and independent notification lifetimes. */
import assert from "node:assert/strict";
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE ?? "playwright-core"
);
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
  assert.ok(
    response.ok,
    `${response.status}: ${await response.clone().text()}`,
  );
  return response.json();
}
assert.equal((await call("/api/creation-test-health")).isolated, true);
const projectId = crypto.randomUUID();
await call(`/api/creation/projects/${projectId}/commands`, {
  projectId,
  commandId: crypto.randomUUID(),
  type: "project.create",
  payload: { name: `Canvas notifications ${projectId.slice(0, 8)}` },
});
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROMIUM_PATH
    ? { executablePath: process.env.CHROMIUM_PATH }
    : {}),
  args: ["--no-sandbox"],
});
try {
  const page = await browser.newPage({
    viewport: { width: 1500, height: 1000 },
  });
  // Skip the first-run model setup welcome; it covers the canvas.
  await page.addInitScript(() =>
    localStorage.setItem("opendirector.modelSetup.v1", "dismissed"),
  );
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  // Simulate an empty model catalog without modifying the fixture's model settings.
  await page.route("**/api/model-configs", (route) =>
    route.fulfill({ json: [] }),
  );
  await page.goto(`${base}/ai-tool/ai-canvas/${projectId}`);
  await page.getByText("已保存到本机", { exact: true }).waitFor();
  const toasts = page.locator(".cw-toast");
  const run = page.getByRole("button", { name: "提交生成", exact: true });
  for (const kind of ["图片", "视频", "音频"]) {
    await page
      .getByRole("toolbar", { name: "画布创作工具" })
      .getByRole("button", { name: `添加${kind}`, exact: true })
      .click();
    const prompt = page.getByRole("textbox", {
      name: "生成提示词",
      exact: true,
    });
    await prompt.fill(`测试${kind}生成提示词`);
    await run.click();
    await toasts.last().waitFor();
    assert.match(await toasts.last().innerText(), /设置 → 模型接入/);
    assert.equal(await page.getByRole("dialog").count(), 0);
    assert.equal(await prompt.innerText(), `测试${kind}生成提示词`);
    await toasts.last().getByRole("button", { name: "关闭提示" }).click();
    await page.mouse.move(1400, 900);
    await toasts.waitFor({ state: "detached" });
    assert.equal(await toasts.count(), 0);
  }
  // Identical notifications must coexist, and the older timer must not erase the newer one.
  await run.click();
  await page.mouse.move(1400, 900);
  await toasts.waitFor();
  await new Promise((resolve) => setTimeout(resolve, 2000));
  await run.click();
  await page.mouse.move(1400, 900);
  assert.equal(await toasts.count(), 2);
  const boxes = await toasts.evaluateAll((items) =>
    items.map((item) => {
      const { top, bottom } = item.getBoundingClientRect();
      return { top, bottom };
    }),
  );
  assert.ok(boxes[1].top >= boxes[0].bottom, JSON.stringify(boxes));
  await toasts.nth(1).waitFor({ state: "detached", timeout: 9000 });
  assert.equal(
    await toasts.count(),
    1,
    "Older notification expires independently",
  );
  // Hovering pauses the remaining lifetime and leaving resumes it.
  await toasts.hover();
  await new Promise((resolve) => setTimeout(resolve, 9000));
  assert.equal(await toasts.count(), 1);
  await page.mouse.move(1400, 900);
  await toasts.waitFor({ state: "detached", timeout: 5000 });
  assert.equal(await toasts.count(), 0);
  // Keyboard focus also pauses expiry while the unfocused sibling expires.
  await run.click();
  await run.click();
  await toasts.first().getByRole("button", { name: "关闭提示" }).focus();
  await toasts.nth(1).waitFor({ state: "detached", timeout: 9000 });
  assert.equal(await toasts.count(), 1);
  await toasts.getByRole("button", { name: "关闭提示" }).click();
  await toasts.waitFor({ state: "detached" });
  assert.equal(await toasts.count(), 0);
  // Record actual frame positions: removing a top or middle item must move
  // every following message through intermediate positions instead of jumping.
  for (const closingIndex of [0, 1]) {
    for (let i = 0; i < 3; i++) await run.click();
    await page.mouse.move(1400, 900);
    await toasts.evaluateAll((items) =>
      Promise.all(
        items.flatMap((item) =>
          item.getAnimations().map((animation) => animation.finished),
        ),
      ),
    );
    const motion = await page.evaluate(async (index) => {
      const items = [...document.querySelectorAll(".cw-toast")];
      const followers = items.slice(index + 1);
      const before = followers.map((item) => item.getBoundingClientRect().top);
      const destination = items[index].getBoundingClientRect().top;
      items[index].querySelector("button").click();
      const frames = [];
      const started = performance.now();
      while (performance.now() - started < 500) {
        await new Promise(requestAnimationFrame);
        frames.push(followers.map((item) => item.getBoundingClientRect().top));
      }
      return { before, destination, frames };
    }, closingIndex);
    const distance = motion.before[0] - motion.destination;
    for (let i = 0; i < motion.before.length; i++) {
      const positions = [
        motion.before[i],
        ...motion.frames.map((frame) => frame[i]),
      ];
      const final = positions.at(-1);
      assert.ok(
        Math.abs(final - (positions[0] - distance)) < 1,
        JSON.stringify(motion),
      );
      assert.ok(
        positions.some((top) => top < positions[0] - 1 && top > final + 1),
        "Following messages must visibly move through intermediate positions",
      );
      const largestStep = Math.max(
        ...positions.slice(1).map((top, j) => Math.abs(top - positions[j])),
      );
      assert.ok(
        largestStep < distance - 1,
        "No frame may jump the whole distance",
      );
    }
    assert.equal(await toasts.count(), 2);
    await toasts.evaluateAll((items) =>
      items.forEach((item) => item.querySelector("button").click()),
    );
    await page.waitForFunction(
      () => document.querySelectorAll(".cw-toast").length === 0,
    );
  }
  const snapshot = await call(`/api/creation/projects/${projectId}`);
  assert.equal(snapshot.jobs.length, 0, "Missing models must not create tasks");
  assert.equal(snapshot.results.length, 0);
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      passed: true,
      projectId,
      checks: [
        "image/video/audio without models",
        "no modal or task",
        "prompt retained",
        "repeated message stacking",
        "independent expiry",
        "hover and focus pause",
        "manual close",
        "smooth reposition after top and middle dismissal",
      ],
    }),
  );
} finally {
  await browser.close();
}
