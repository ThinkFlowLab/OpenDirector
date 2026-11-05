/** Isolated fixture only: compact spacing and an expanded editor keep one draft. */
import assert from "node:assert/strict";
import { join } from "node:path";
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE ?? "playwright-core"
);
const base = process.env.CREATION_WEB_URL ?? "http://127.0.0.1:8019";
const api = process.env.CREATION_API_URL ?? base;
const headers = {
  "X-OpenDirector-Request": "1",
  "Content-Type": "application/json",
};
async function call(path, body) {
  const response = await fetch(api + path, {
    headers,
    ...(body ? { method: "POST", body: JSON.stringify(body) } : {}),
  });
  assert.ok(
    response.ok,
    `${response.status}: ${await response.clone().text()}`,
  );
  return response.json();
}
const health = await call("/api/creation-test-health");
assert.equal(health.isolated, true);
const projectId = crypto.randomUUID();
await call(`/api/creation/projects/${projectId}/commands`, {
  commandId: crypto.randomUUID(),
  projectId,
  type: "project.create",
  payload: { name: `Composer expansion ${projectId.slice(0, 8)}` },
});
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROMIUM_PATH
    ? { executablePath: process.env.CHROMIUM_PATH }
    : {}),
});
try {
  const page = await browser.newPage({
    viewport: { width: 1600, height: 1000 },
  });
  // Skip the first-run model setup welcome; it covers the canvas.
  await page.addInitScript(() =>
    localStorage.setItem("opendirector.modelSetup.v1", "dismissed"),
  );
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${base}/ai-tool/ai-canvas/${projectId}`, {
    waitUntil: "domcontentloaded",
  });
  await page.getByText("已保存到本机", { exact: true }).waitFor();
  const checked = [];
  for (const kind of ["视频", "图片"]) {
    await page
      .getByRole("toolbar", { name: "画布创作工具" })
      .getByRole("button", { name: `添加${kind}`, exact: true })
      .click();
    if (kind === "图片") {
      const model = (await call("/api/model-configs")).find(
        (model) => model.modelId === "Qwen/Qwen-Image-2.1",
      );
      assert.ok(model);
      await page
        .getByLabel("生成模型", { exact: true })
        .selectOption(`config:${model.id}`);
    }
    const editor = page.getByRole("textbox", {
      name: "生成提示词",
      exact: true,
    });
    const prompt = Array.from(
      { length: 60 },
      (_, i) => `镜头${i + 1}：保持动作和运镜，只替换角色外观。`,
    ).join("\n");
    await editor.fill(prompt);
    await page.getByText("已保存到本机", { exact: true }).waitFor();
    const dock = page.locator('.cw-composer-dock[data-expandable="true"]');
    const zoomSizes = [];
    for (const percent of [50, 61, 100, 150, 100]) {
      await page.getByRole("button", { name: "缩放选项", exact: true }).click();
      await page
        .getByRole("spinbutton", { name: "缩放百分比", exact: true })
        .fill(String(percent));
      await page.getByRole("button", { name: "缩放选项", exact: true }).click();
      await page.waitForFunction((expected) => {
        const viewport = document.querySelector(".react-flow__viewport");
        return (
          viewport &&
          Math.abs(
            new DOMMatrix(getComputedStyle(viewport).transform).a - expected,
          ) < 0.001
        );
      }, percent / 100);
      await dock.waitFor({ state: "visible" });
      const size = await dock.evaluate((element) => {
        const input = element.querySelector('[role="textbox"]');
        const scale = input.getBoundingClientRect().width / input.offsetWidth;
        return {
          width: element.getBoundingClientRect().width,
          effectiveFont:
            Number.parseFloat(getComputedStyle(input).fontSize) * scale,
          nodeGap:
            element.getBoundingClientRect().top -
            document
              .querySelector(".react-flow__node.selected")
              .getBoundingClientRect().bottom,
        };
      });
      assert.ok(
        Math.abs(size.effectiveFont - 13) < 0.1,
        JSON.stringify({ percent, ...size }),
      );
      assert.ok(
        Math.abs(size.nodeGap - 16) < 1,
        JSON.stringify({ percent, ...size }),
      );
      zoomSizes.push(size.width);
    }
    assert.ok(
      Math.max(...zoomSizes) - Math.min(...zoomSizes) < 1,
      JSON.stringify(zoomSizes),
    );
    const compact = await dock.evaluate((element) => {
      window.__composerEditor = element.querySelector('[role="textbox"]');
      const body = element.querySelector(".cw-composer-body");
      const input = element.querySelector('[role="textbox"]');
      const footer = element.querySelector(".cw-composer-footer");
      const shell = element.querySelector(".cw-composer");
      const strip = body.querySelector(".cw-reference-strip");
      const scale = element.getBoundingClientRect().width / element.offsetWidth;
      const style = getComputedStyle(input);
      return {
        width: element.getBoundingClientRect().width,
        height: element.getBoundingClientRect().height,
        inputHeight: input.getBoundingClientRect().height / scale,
        tenLines:
          parseFloat(style.lineHeight) * 10 +
          parseFloat(style.paddingTop) +
          parseFloat(style.paddingBottom),
        inputScrollable: input.scrollHeight > input.clientHeight,
        gap: strip
          ? (input.getBoundingClientRect().top -
              strip.querySelector("button").getBoundingClientRect().bottom) /
            scale
          : 0,
        bottom:
          (shell.getBoundingClientRect().bottom -
            footer.getBoundingClientRect().bottom) /
          scale,
      };
    });
    assert.ok(compact.gap <= 12, JSON.stringify(compact));
    assert.ok(compact.bottom <= 10, JSON.stringify(compact));
    assert.ok(
      compact.inputHeight <= compact.tenLines + 1,
      JSON.stringify(compact),
    );
    assert.equal(compact.inputScrollable, true);
    if (kind === "视频" && process.env.COMPOSER_SCREENSHOT_DIR)
      await page.screenshot({
        path: join(process.env.COMPOSER_SCREENSHOT_DIR, "composer-compact.png"),
      });
    await page.getByRole("button", { name: "展开会话框", exact: true }).click();
    await page
      .getByRole("dialog", { name: "展开的节点会话框", exact: true })
      .waitFor();
    assert.equal(
      await editor.evaluate((element) => element === window.__composerEditor),
      true,
      "Expansion must keep the existing rich editor mounted",
    );
    assert.equal(await editor.innerText(), prompt);
    const expanded = await dock.boundingBox();
    assert.ok(
      expanded.width > compact.width,
      JSON.stringify({ compact, expanded }),
    );
    assert.ok(
      expanded.height > compact.height + 150,
      JSON.stringify({ compact, expanded }),
    );
    assert.ok(
      expanded.x >= 0 &&
        expanded.y >= 0 &&
        expanded.x + expanded.width <= 1600 &&
        expanded.y + expanded.height <= 1000,
    );
    const scrolling = await dock.evaluate((element) => {
      const input = element.querySelector('[role="textbox"]');
      const footer = element.querySelector(".cw-composer-footer");
      const before = footer.getBoundingClientRect().top;
      input.scrollTop = 500;
      return {
        scrollTop: input.scrollTop,
        overflow: input.scrollHeight > input.clientHeight,
        footerMoved: footer.getBoundingClientRect().top !== before,
        visible:
          footer.getBoundingClientRect().bottom <=
          element.getBoundingClientRect().bottom,
      };
    });
    assert.deepEqual(scrolling, {
      scrollTop: 500,
      overflow: true,
      footerMoved: false,
      visible: true,
    });
    if (kind === "视频" && process.env.COMPOSER_SCREENSHOT_DIR)
      await page.screenshot({
        path: join(
          process.env.COMPOSER_SCREENSHOT_DIR,
          "composer-expanded.png",
        ),
      });
    const collapse = page.getByRole("button", {
      name: "收起会话框",
      exact: true,
    });
    await collapse.focus();
    await collapse.press("Shift+Tab");
    assert.equal(
      await dock.evaluate((element) =>
        element.contains(document.activeElement),
      ),
      true,
    );
    await page.keyboard.press("Tab");
    assert.equal(
      await collapse.evaluate((element) => element === document.activeElement),
      true,
    );
    // @ and parameter popovers must remain usable above the expanded panel.
    await page.getByRole("button", { name: "生成参数", exact: true }).click();
    const parameters = page.getByRole("dialog", {
      name: "生成参数设置",
      exact: true,
    });
    await parameters.waitFor();
    await parameters.getByRole("button", { name: "9:16", exact: true }).click();
    await parameters.press("Escape");
    await parameters.waitFor({ state: "hidden" });
    assert.equal(await dock.getAttribute("data-expanded"), "true");
    const picker = page.getByRole("dialog", {
      name: "引用项目资产",
      exact: true,
    });
    await editor.press("Control+Home");
    await editor.press("End");
    await editor.press("@");
    await picker.waitFor();
    const belowCaret = await picker.evaluate((element) => {
      const caret = document
        .getSelection()
        .getRangeAt(0)
        .getBoundingClientRect();
      const bounds = element.getBoundingClientRect();
      return (
        Math.abs(bounds.left - caret.left) < 2 &&
        Math.abs(bounds.top - caret.bottom - 6) < 2
      );
    });
    assert.equal(
      belowCaret,
      true,
      "The expanded picker opens below the caret when it fits",
    );
    await editor.press("Escape");
    await editor.press("Backspace");
    await editor.press("Control+End");
    await editor.press("Enter");
    await editor.press("@");
    await page
      .getByRole("dialog", { name: "引用项目资产", exact: true })
      .waitFor();
    await editor.press("Escape");
    await page
      .getByRole("dialog", { name: "引用项目资产", exact: true })
      .waitFor({ state: "hidden" });
    assert.equal(await dock.getAttribute("data-expanded"), "true");
    await editor.press("Escape");
    await page
      .getByRole("button", { name: "展开会话框", exact: true })
      .waitFor();
    assert.equal(await dock.getAttribute("data-expanded"), "false");
    assert.match(
      await page
        .getByRole("button", { name: "生成参数", exact: true })
        .innerText(),
      /9:16/,
    );
    assert.equal(
      await editor.evaluate((element) => element === window.__composerEditor),
      true,
    );
    assert.ok((await editor.innerText()).startsWith(prompt));
    await page.getByRole("button", { name: "展开会话框", exact: true }).click();
    await page.getByRole("button", { name: "收起会话框", exact: true }).click();
    assert.equal(await dock.getAttribute("data-expanded"), "false");
    checked.push(kind);
  }
  await page.getByRole("button", { name: "展开会话框", exact: true }).click();
  await page.setViewportSize({ width: 640, height: 600 });
  const dock = page.locator('.cw-composer-dock[data-expanded="true"]');
  const small = await dock.boundingBox();
  assert.ok(
    small.x >= 0 &&
      small.y >= 0 &&
      small.x + small.width <= 640 &&
      small.y + small.height <= 600,
  );
  await page
    .locator(".cw-composer-backdrop")
    .click({ position: { x: 2, y: 2 } });
  assert.equal(
    await page.locator(".cw-composer-dock").getAttribute("data-expanded"),
    "false",
  );
  assert.equal(
    (await call("/api/creation-test-health")).calls.length,
    health.calls.length,
  );
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      isolated: true,
      editors: checked,
      compactSpacing: true,
      expandedViewport: true,
      sameEditorAndDraft: true,
      fixedSizeAcrossCanvasZoom: true,
      internalScrolling: true,
      escapeLayers: true,
      smallViewport: true,
      backdropCollapse: true,
      errors,
    }),
  );
} finally {
  await browser.close();
}
