/** Harness-independent activity rendering against Vite; no project or model calls. */
import assert from "node:assert/strict";
import { launchBrowser } from "./engine.mjs";

const base = process.env.CREATION_WEB_URL ?? "http://127.0.0.1:5179";
const browser = await launchBrowser();
const page = await browser.newPage({ locale: "en-US", viewport: { width: 900, height: 900 } });
page.setDefaultTimeout(10000);
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const prefix = "Check the sources first. 🌊";
const tools = (count) => Array.from({ length: count }, (_, index) => ({
  id: `call-${index}`, name: "web_fetch", textOffset: Array.from(prefix).length,
  status: index === count - 1 ? "running" : "complete",
  arguments: { url: `https://example.test/${index}` },
}));
const message = (calls, text = prefix) => ({
  id: "reply", role: "assistant", status: "streaming", text, tools: calls,
});
try {
  await page.goto(base + "/tests/browser/assistant_activity.html");
  await page.evaluate(async () => {
    const { mountReply } = await import("/tests/browser/assistant_activity_fixture.tsx");
    window.replyFixture = mountReply(document.getElementById("activity-test"));
  });
  const render = (value, thinking = false) => page.evaluate(({ value, thinking }) =>
    window.replyFixture.render(value, thinking), { value, thinking });
  const group = page.locator(".cw-chat-tool-group > details");
  const calls = tools(1000);
  await render(message(calls));
  await page.locator('.cw-chat-execution-history > summary').click();
  await group.getByText("Activity · 1000 calls", { exact: true }).waitFor();
  await page.locator(".cw-chat-tool-group-items").waitFor({ state: "detached" });
  assert.equal(await group.getAttribute("open"), null);
  assert.equal(await page.locator('[role="status"]').innerText(), "Running: Read a web page");
  assert.equal(await page.locator(".cw-chat-markdown").innerText(), prefix);

  await group.locator(":scope > summary").click();
  await page.waitForFunction(() => document.querySelectorAll(".cw-chat-tool-group-items > details").length === 50);
  const first = group.locator(".cw-chat-tool-group-items > details").first();
  await first.locator(":scope > summary").click();
  calls.push({ ...calls.at(-1), id: "call-1000" });
  await render(message(calls));
  await page.waitForFunction(() => document.querySelectorAll(".cw-chat-tool-group-items > details").length === 51);
  assert.notEqual(await first.getAttribute("open"), null);
  assert.notEqual(await group.getAttribute("open"), null);
  await group.getByRole("button", { name: "Show 50 earlier calls", exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll(".cw-chat-tool-group-items > details").length === 101);

  await group.locator(":scope > summary").click();
  await page.waitForFunction(() => !document.querySelector(".cw-chat-tool-group-items"));
  calls.forEach((call, index) => {
    if (call.status === "running") calls[index] = { ...call, status: "complete" };
  });
  calls[calls.length - 1] = { ...calls.at(-1), status: "failed", error: "Page unavailable" };
  await render({ ...message(calls, prefix + "Done."), status: "complete" });
  await group.getByText("1000/1001 complete · 1 failed", { exact: true }).waitFor();
  assert.equal(await page.getByText("Page unavailable", { exact: true }).count(), 0);
  assert.equal(await group.evaluate((element) => element.classList.contains('is-failed')), false);
  await group.locator(":scope > summary").click();
  const failure = page.locator('.cw-chat-tool-group-items > details.is-failed');
  await failure.locator(':scope > summary').click();
  await page.getByText("Page unavailable", { exact: true }).waitFor();
  await group.locator(":scope > summary").click();
  await page.locator(".cw-chat-tool-group-items").waitFor({ state: "detached" });
  assert.equal(await page.locator(".cw-chat-markdown").last().innerText(), "Done.");
  assert.equal(await page.locator('[role="status"]').count(), 0);

  await render({ ...message([]), plan: [{ content: "Check assets", status: "in_progress" }] });
  await page.getByText("Running plan: Check assets", { exact: true }).waitFor();
  await page.locator(".cw-chat-plan > summary").click();
  await page.getByText("Check assets", { exact: true }).waitFor();
  await render(message([]), true);
  await page.getByText("Thinking…", { exact: true }).waitFor();

  // Real reply component, shared formatter and clipboard; no model calls.
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
      writeText: async (text) => { window.copiedReply = text; },
    } });
  });
  const citation = (id) => `\uE200cite\uE202${id}\uE201`;
  const sourceA = { id: "turn1search0", url: "https://example.test/a", title: "Source A" };
  const sourceB = { id: "turn2view0", url: "https://example.test/b", title: "Source B" };
  const complete = {
    ...message([], `Result🌊${citation(sourceA.id)}\n\nHistory${citation(sourceB.id)}\n\nMore${citation(sourceA.id)}\n\nLast${citation(sourceB.id)}`),
    status: "complete", sources: [sourceA, sourceB],
  };
  await render(complete);
  const markdown = page.locator('.cw-chat-markdown');
  const links = markdown.locator('[data-streamdown="link"]');
  await links.nth(3).waitFor();
  assert.equal(await links.count(), 4);
  assert.deepEqual(await links.allTextContents(), ['[1]', '[2]', '[1]', '[2]']);
  // Citation cards retain source addresses and restore focus on close.
  for (const [index, source] of [[0, sourceA], [1, sourceB], [2, sourceA]]) {
    await links.nth(index).click();
    const modal = page.locator('[data-streamdown="link-safety-modal"]');
    await modal.getByText(source.url, { exact: true }).waitFor();
    await modal.getByRole('button', { name: 'Close', exact: true }).click();
    assert.equal(await links.nth(index).evaluate((element) => element === document.activeElement), true);
  }
  assert.doesNotMatch(await markdown.innerText(), /[\uE200-\uE202]|turn\d/);
  await page.getByRole('button', { name: 'Copy reply', exact: true }).click();
  await page.waitForFunction(() => typeof window.copiedReply === 'string');
  const copied = await page.evaluate(() => window.copiedReply);
  assert.doesNotMatch(copied, /[\uE200-\uE202]|turn\d/);
  assert.ok(copied.includes(sourceA.url) && copied.includes(sourceB.url));

  // A fresh mount represents history reopened from the server's saved message.
  await page.evaluate(async (value) => {
    window.replyFixture.unmount();
    const { mountReply } = await import('/tests/browser/assistant_activity_fixture.tsx');
    window.replyFixture = mountReply(document.getElementById('activity-test'));
    window.replyFixture.render(value);
  }, complete);
  await links.nth(3).waitFor();
  const partial = { ...complete, status: 'streaming', text: 'Result\uE200cite\uE202turn1' };
  await render(partial);
  await page.waitForFunction(() => document.querySelector('.cw-chat-markdown')?.textContent === 'Result');
  await render({ ...complete, status: 'streaming' });
  await links.nth(3).waitFor();
  for (const [locale, expected] of [['zh-CN', '来源不可用'], ['en-US', 'Source unavailable']]) {
    await page.evaluate(({ value, locale }) => {
      localStorage.setItem("opendirector.locale.v1", locale);
      window.replyFixture.render(value, false, locale);
    }, {
      value: { ...complete, text: `Before${citation('turn9search9')}After\n\nPartial\uE200cite\uE202turn9`, sources: [] }, locale,
    });
    await markdown.getByText(`Before[${expected}]After`, { exact: true }).waitFor();
    assert.ok((await markdown.innerText()).includes(`Partial[${expected}]`));
    assert.doesNotMatch(await markdown.innerText(), /[\uE200-\uE202]|turn9/);
    await page.evaluate(({ value, locale }) => window.replyFixture.render(value, false, locale), { value: complete, locale });
    await links.first().waitFor();
    await links.first().click();
    const modal = page.locator('[data-streamdown="link-safety-modal"]');
    await modal.getByText(locale === 'zh-CN' ? '即将访问以下外部网站，请确认链接地址。' : 'You are about to visit the following external website. Check the link address before opening it.', { exact: true }).waitFor();
    assert.equal(await modal.getByText(locale === 'zh-CN' ? '打开外部链接' : 'Open external link', { exact: true }).count(), 0);
    assert.equal(await modal.getAttribute('role'), 'dialog');
    assert.equal(await modal.getAttribute('aria-label'), locale === 'zh-CN' ? '打开外部链接' : 'Open external link');
    await modal.getByRole('button', { name: locale === 'zh-CN' ? '关闭' : 'Close', exact: true }).click();
  }

  // Long URLs, geometry and keyboard behavior in both theme presentations.
  const longSource = { ...sourceA, url: 'https://example.test/' + 'long-path-'.repeat(70) + '?q=full-address' };
  await page.setViewportSize({ width: 390, height: 800 });
  await render({ ...complete, text: `Result${citation(longSource.id)}`, sources: [longSource] });
  for (const theme of ['dark', 'light']) {
    await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, theme);
    await links.first().click();
    const modal = page.locator('.cw-chat-link-info');
    const close = modal.getByRole('button', { name: 'Close', exact: true });
    await close.waitFor();
    const geometry = await modal.evaluate((element) => {
      const card = element.getBoundingClientRect();
      const button = element.querySelector('.cw-chat-link-close').getBoundingClientRect();
      const url = element.querySelector('.cw-chat-link-url');
      const styles = getComputedStyle(element);
      return { border: styles.borderTopWidth, borderStyle: styles.borderTopStyle,
        background: styles.backgroundColor, topGap: button.top - card.top, rightGap: card.right - button.right,
        scrollWidth: element.scrollWidth, width: element.clientWidth,
        urlWidth: url.clientWidth, urlScrollWidth: url.scrollWidth };
    });
    assert.equal(geometry.border, '1px');
    assert.equal(geometry.borderStyle, 'solid');
    assert.notEqual(geometry.background, 'rgba(0, 0, 0, 0)');
    assert.ok(geometry.topGap >= 8 && geometry.topGap <= 10);
    assert.ok(geometry.rightGap >= 8 && geometry.rightGap <= 10);
    assert.ok(geometry.scrollWidth <= geometry.width + 1);
    assert.ok(geometry.urlScrollWidth <= geometry.urlWidth + 1);
    assert.equal(await modal.locator('.cw-chat-link-url').innerText(), longSource.url);
    assert.equal(await close.evaluate((element) => element === document.activeElement), true);
    await modal.getByRole('button', { name: 'Copy link', exact: true }).click();
    await page.waitForFunction((url) => window.copiedReply === url, longSource.url);
    await modal.getByRole('button', { name: 'Copied', exact: true }).waitFor();
    await page.keyboard.press('Escape');
    await modal.waitFor({ state: 'detached' });
    assert.equal(await links.first().evaluate((element) => element === document.activeElement), true);
  }

  await links.first().click();
  const modal = page.locator('.cw-chat-link-info');
  await page.evaluate(() => {
    navigator.clipboard.writeText = async () => { throw new Error('Clipboard unavailable'); };
    window.openedLinks = [];
    window.open = (url) => { window.openedLinks.push(url); return null; };
  });
  await modal.getByRole('button', { name: 'Copy link', exact: true }).click();
  await modal.getByRole('status').getByText('Copy failed; select the URL to copy it', { exact: true }).waitFor();
  await modal.getByRole('button', { name: 'Open link', exact: true }).click();
  await modal.waitFor({ state: 'detached' });
  assert.deepEqual(await page.evaluate(() => window.openedLinks), [longSource.url]);
  await links.first().click();
  await modal.waitFor();
  await page.locator('.cw-chat-message-actions').click();
  await modal.waitFor({ state: 'detached' });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, checks: ["1000 collapsed calls", "lazy pagination", "stable disclosure state", "muted failure with expandable details", "public messages", "plan and thinking", "four citation groups", "copy and reopen", "partial streaming citation", "bilingual missing sources", "card border and top-right close", "dark and light long URLs", "keyboard and focus restoration", "copy errors and opening links"] }));
} finally {
  await page.evaluate(() => window.replyFixture?.unmount()).catch(() => {});
  await browser.close();
}
