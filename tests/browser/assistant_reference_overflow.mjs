/** Sent-bubble reference chips must truncate long names without covering adjacent text.
 * Mounts /tests/browser/assistant_reference_overflow_fixture.tsx through Vite.
 * No project, provider, or model calls.
 */
import assert from "node:assert/strict";
import { launchBrowser } from "./engine.mjs";

const LONG_ZH =
  "角色三视图设定稿：在同一张画面中并排绘制同一人物的正面、侧面（90度侧脸）和背面三个视角，三个人物高度尽量一致、脚部处于同一水平线，穿着与发型在三视图中完全一致.png";
const LONG_EN =
  "Character three-view turnaround sheet: front, 90-degree side and back of the same person on one page, aligned feet and identical costume.png";
const SHORT_ZH = "导演台 1 · 动作预演";

const base = process.env.CREATION_WEB_URL ?? "http://127.0.0.1:5179";
const browser = await launchBrowser();
const page = await browser.newPage({
  // Chromium language only. The fixture switches zh-CN / en-US itself via
  // setActiveLocale; this script does not assert Playwright-selected UI copy.
  locale: "en-US",
  viewport: { width: 1100, height: 900 },
});
page.setDefaultTimeout(10000);
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));

function measure(chip, followingText) {
  return chip.evaluate((element, expectedFollowing) => {
    const chipRect = element.getBoundingClientRect();
    const label =
      element.querySelector(".cw-chat-reference-label") ??
      [...element.querySelectorAll("span")].find(
        (node) => node.textContent && !node.querySelector("svg"),
      ) ??
      null;
    const range = document.createRange();
    const textRects = [];
    if (label) {
      range.selectNodeContents(label);
      textRects.push(...range.getClientRects());
    }
    const style = label ? getComputedStyle(label) : null;
    const chipStyle = getComputedStyle(element);
    const clipsHorizontally =
      ["hidden", "clip", "scroll", "auto"].includes(chipStyle.overflowX) ||
      ["hidden", "clip", "scroll", "auto"].includes(style?.overflowX ?? "");
    // nowrap+ellipsis Range rects may extend past the clipped box horizontally;
    // that is not visible. The defect is wrapped text leaking below the 1.5em chip.
    const overflowRects = textRects.filter((rect) => {
      const belowOrAbove =
        rect.bottom > chipRect.bottom + 1 || rect.top < chipRect.top - 1;
      const sideways =
        rect.right > chipRect.right + 1 || rect.left < chipRect.left - 1;
      return belowOrAbove || (sideways && !clipsHorizontally);
    });
    const article = element.closest("article");
    const toggle = article?.querySelector(".cw-chat-attachments-toggle");
    const toggleRect = toggle?.getBoundingClientRect();
    const overlap = (a, b, slack = 0.5) => {
      if (!a || !b) return 0;
      const ix = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const iy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      return ix > slack && iy > slack ? ix * iy : 0;
    };
    let followingRects = [];
    if (expectedFollowing && element.parentElement) {
      const parent = element.parentElement;
      const index = [...parent.childNodes].indexOf(element);
      for (let i = index + 1; i < parent.childNodes.length; i += 1) {
        const node = parent.childNodes[i];
        if (
          node.nodeType === Node.TEXT_NODE &&
          node.textContent.includes(expectedFollowing)
        ) {
          range.selectNodeContents(node);
          followingRects = [...range.getClientRects()];
          break;
        }
      }
    }
    const coverage = (targets) =>
      overflowRects.reduce(
        (sum, rect) =>
          sum +
          targets.reduce((inner, target) => inner + overlap(rect, target), 0),
        0,
      );
    return {
      chipHeight: chipRect.height,
      chipWidth: chipRect.width,
      labelText: label?.textContent ?? "",
      whiteSpace: style?.whiteSpace ?? "",
      textOverflow: style?.textOverflow ?? "",
      overflow: style?.overflow ?? "",
      labelScrollWidth: label?.scrollWidth ?? 0,
      labelClientWidth: label?.clientWidth ?? 0,
      title:
        element.getAttribute("title") || label?.getAttribute("title") || "",
      ariaLabel: element.getAttribute("aria-label") || "",
      overflow: overflowRects.length > 0,
      overflowRectCount: overflowRects.length,
      overlapFollowing: coverage(followingRects),
      overlapToggle: toggleRect ? coverage([toggleRect]) : 0,
      followingTop: followingRects[0]?.top ?? null,
      toggleTop: toggleRect?.top ?? null,
      chipBottom: chipRect.bottom,
    };
  }, followingText);
}

try {
  await page.goto(base + "/tests/browser/assistant_reference_overflow.html");
  await page.evaluate(async () => {
    const { mountReferenceOverflow } =
      await import("/tests/browser/assistant_reference_overflow_fixture.tsx");
    window.referenceOverflowFixture = mountReferenceOverflow(
      document.getElementById("reference-overflow-test"),
    );
  });
  const render = (locale, width, theme) =>
    page.evaluate(
      ({ locale, width, theme }) =>
        window.referenceOverflowFixture.render(locale, width, theme),
      { locale, width, theme },
    );

  const cases = [
    { locale: "zh-CN", width: 420, theme: "dark" },
    { locale: "zh-CN", width: 280, theme: "dark" },
    { locale: "en-US", width: 420, theme: "light" },
    { locale: "en-US", width: 280, theme: "light" },
  ];

  for (const view of cases) {
    await render(view.locale, view.width, view.theme);
    const suffix = `${view.locale} ${view.theme} ${view.width}px`;

    const longZh = page.locator(
      'article[data-case="long-zh"] .cw-chat-reference[data-preview-asset="long-image"]',
    );
    const longEn = page.locator(
      'article[data-case="long-en"] .cw-chat-reference[data-preview-asset="long-en"]',
    );
    const short = page.locator(
      'article[data-case="short-only"] .cw-chat-reference',
    );
    const icon = page.locator(
      'article[data-case="icon-only"] .cw-chat-reference',
    );
    const composer = page.locator("[data-composer] .cw-chat-reference");

    await longZh.waitFor();
    const zh = await measure(longZh, "，场景为 nvdia 大楼");
    assert.equal(
      zh.overflow,
      false,
      `long zh name overflows the chip (${suffix}): ${JSON.stringify(zh)}`,
    );
    assert.equal(
      zh.overlapFollowing,
      0,
      `long zh name covers following text (${suffix}): ${JSON.stringify(zh)}`,
    );
    assert.equal(
      zh.overlapToggle,
      0,
      `long zh name covers the attachment toggle (${suffix}): ${JSON.stringify(zh)}`,
    );
    assert.equal(
      zh.whiteSpace,
      "nowrap",
      `long zh name must stay on one line (${suffix})`,
    );
    assert.equal(
      zh.textOverflow,
      "ellipsis",
      `long zh name must ellipsize (${suffix})`,
    );
    assert.ok(
      zh.labelScrollWidth > zh.labelClientWidth + 1,
      `long zh name was not truncated (${suffix}): ${JSON.stringify(zh)}`,
    );
    assert.ok(
      zh.title.includes("角色三视图设定稿") && zh.title.endsWith(".png"),
      `missing hover title (${suffix}): ${zh.title}`,
    );
    assert.ok(
      zh.ariaLabel.includes("角色三视图设定稿"),
      `missing accessible name (${suffix}): ${zh.ariaLabel}`,
    );
    assert.ok(
      zh.chipHeight > 10 && zh.chipHeight < 28,
      `chip height should stay about 1.5em (${suffix}): ${zh.chipHeight}`,
    );

    const en = await measure(longEn, " in this shot.");
    assert.equal(
      en.overflow,
      false,
      `long en name overflows the chip (${suffix}): ${JSON.stringify(en)}`,
    );
    assert.equal(
      en.overlapFollowing,
      0,
      `long en name covers following text (${suffix})`,
    );
    assert.equal(
      en.overlapToggle,
      0,
      `long en name covers the attachment toggle (${suffix})`,
    );
    assert.ok(
      en.labelScrollWidth > en.labelClientWidth + 1,
      `long en name was not truncated (${suffix})`,
    );
    assert.ok(
      en.title.includes("Character three-view"),
      `missing English hover title (${suffix}): ${en.title}`,
    );

    const shortMeasure = await measure(short, "即可");
    assert.equal(
      shortMeasure.labelText,
      SHORT_ZH,
      `short name changed (${suffix})`,
    );
    assert.equal(
      shortMeasure.overflow,
      false,
      `short name overflows (${suffix})`,
    );
    assert.ok(
      shortMeasure.labelScrollWidth <= shortMeasure.labelClientWidth + 1,
      `short name should not ellipsize (${suffix}): ${JSON.stringify(shortMeasure)}`,
    );

    const iconMeasure = await measure(icon, "引用");
    assert.equal(
      iconMeasure.overflow,
      false,
      `icon-only chip overflows (${suffix})`,
    );
    assert.equal(
      iconMeasure.overlapFollowing,
      0,
      `icon-only chip covers following text (${suffix})`,
    );

    const composerMeasure = await measure(composer, "继续");
    assert.equal(
      composerMeasure.overflow,
      false,
      `composer chip overflows (${suffix})`,
    );
    assert.equal(
      composerMeasure.whiteSpace,
      "nowrap",
      `composer truncation regressed (${suffix})`,
    );
    assert.equal(
      composerMeasure.textOverflow,
      "ellipsis",
      `composer ellipsis regressed (${suffix})`,
    );
    assert.ok(
      composerMeasure.labelScrollWidth > composerMeasure.labelClientWidth + 1,
      `composer long name was not truncated (${suffix})`,
    );
  }

  assert.equal(errors.length, 0, errors.join("\n"));
} finally {
  await browser.close();
}
