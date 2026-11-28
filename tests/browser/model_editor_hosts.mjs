import assert from "node:assert/strict";
import { launchBrowser } from "./engine.mjs";

/**
 * The model service editor is rendered by two hosts: the settings dialog and
 * the first-run setup page. Both must give the same control metrics, because
 * the shared CSS is the only thing that styles them.
 */
const base = process.env.CREATION_WEB_URL ?? "http://127.0.0.1:5179";
const headers = { "X-OpenDirector-Request": "1" };
const health = await fetch(base + "/api/creation-test-health", { headers });
assert.ok(health.ok, "Requires an isolated creation API");

const projectId = crypto.randomUUID();
const create = await fetch(`${base}/api/creation/projects/${projectId}/commands`, {
  method: "POST",
  headers: { ...headers, "Content-Type": "application/json" },
  body: JSON.stringify({
    projectId,
    commandId: crypto.randomUUID(),
    type: "project.create",
    payload: { name: `Model editor hosts ${projectId.slice(0, 8)}` },
  }),
});
assert.ok(create.ok, await create.text());

const browser = await launchBrowser();
try {
  const page = await browser.newPage({ locale: "zh-CN", viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(15000);
  await page.route("**/assistant/runtimes/default/status", (route) => route.fulfill({ json: {
    id: "default", label: "Default Agent", group: "default", modelSource: "settings",
    modelOverride: false, available: true, status: "ready",
  } }));
  await page.goto(`${base}/ai-tool/ai-canvas/${projectId}?creation=unified&setup=welcome&from=onboarding`);
  await page.locator("dialog.cw-welcome").waitFor();
  await page.getByRole("button", { name: "开始设置" }).click();
  await page.getByRole("button", { name: "配置语言模型" }).click();
  await page.getByRole("button", { name: "添加语言模型" }).click();

  const editor = page.locator("form.cw-model-editor");
  await editor.waitFor();
  const details = page.locator("details.cw-model-connection-details").first();
  if ((await details.count()) > 0) await details.evaluate((node) => { node.open = true; });

  const measured = await editor.evaluate((form) => {
    const read = (selector) => {
      const element = form.querySelector(selector);
      if (!element) return null;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return {
        minHeight: style.minHeight,
        fontSize: style.fontSize,
        radius: style.borderTopLeftRadius,
        borderWidth: style.borderTopWidth,
        borderStyle: style.borderTopStyle,
        padding: style.padding,
        background: style.backgroundColor,
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        direction: style.flexDirection,
        align: style.alignItems,
        gap: style.gap,
      };
    };
    const token = getComputedStyle(form).getPropertyValue("--settings-control-height").trim();
    return {
      font: getComputedStyle(form).fontSize,
      controlHeight: token,
      url: read(".cw-model-connection-field input"),
      proxy: read(".cw-model-connection-field select"),
      autoCheck: read('.cw-model-connection-field > label:has(> input[type="checkbox"])'),
      autoCheckBox: read('.cw-model-connection-field > label > input[type="checkbox"]'),
      noAuth: read(".cw-model-no-auth"),
      footerPrimary: read(".cw-model-editor-footer .cw-settings-button-primary"),
      back: read(".cw-model-editor-header .cw-settings-button-icon"),
    };
  });

  for (const name of ["url", "proxy", "autoCheck", "autoCheckBox", "noAuth", "footerPrimary", "back"]) {
    assert.ok(measured[name], `${name} must exist in the first-run model editor`);
  }

  assert.equal(measured.font, "13px", "the editor root must inherit the settings font");
  assert.equal(measured.controlHeight, "36px", "the editor root must declare the shared control metrics");
  for (const name of ["url", "proxy", "footerPrimary"]) {
    assert.equal(measured[name].minHeight, "36px", `${name} must keep the shared control height`);
    assert.equal(measured[name].fontSize, "13px", `${name} must keep the shared control font size`);
  }
  for (const name of ["url", "proxy", "footerPrimary"]) {
    assert.equal(measured[name].radius, "8px", `${name} must keep the shared control radius`);
  }
  assert.equal(measured.footerPrimary.borderWidth, "1px", "buttons must keep a visible border");
  assert.equal(measured.footerPrimary.borderStyle, "solid", "buttons must keep a visible border");
  assert.equal(measured.footerPrimary.padding, "7px 10px", "buttons must keep the shared padding");
  assert.notEqual(measured.footerPrimary.background, "rgba(0, 0, 0, 0)", "buttons must keep a surface");
  assert.equal(measured.back.width, 36, "the icon button must keep its square width");
  assert.equal(measured.noAuth.fontSize, "12px", "the no-key label must keep the caption size");

  assert.equal(measured.autoCheck.direction, "row", "a checkbox label reads as one row");
  assert.equal(measured.autoCheck.align, "center");
  assert.equal(measured.autoCheck.gap, "8px");
  assert.ok(measured.autoCheck.height <= 24, `a checkbox row must stay one line, got ${measured.autoCheck.height}px`);
  assert.equal(measured.autoCheckBox.width, 14, "a checkbox keeps its own size instead of filling the row");
  assert.ok(measured.autoCheckBox.height <= 20, "a checkbox keeps its own height");

  console.log("model editor hosts: shared metrics, font and control sizing match");
} finally {
  await browser.close();
}
