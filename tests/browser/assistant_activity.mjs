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
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, checks: ["1000 collapsed calls", "lazy pagination", "stable disclosure state", "muted failure with expandable details", "public messages", "plan and thinking"] }));
} finally {
  await page.evaluate(() => window.replyFixture?.unmount()).catch(() => {});
  await browser.close();
}
