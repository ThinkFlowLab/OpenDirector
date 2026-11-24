/** Full batch review against a loopback image provider, in both UI languages. */
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { execFile, spawnSync } from "node:child_process";
import { launchBrowser } from "./engine.mjs";

const web = process.env.CREATION_WEB_URL ?? "http://127.0.0.1:5179";
const api = process.env.CREATION_API_URL ?? "http://127.0.0.1:8019";
async function call(path, payload, method = payload ? "POST" : "GET") {
  const response = await fetch(api + path, {
    method, headers: { "X-OpenDirector-Request": "1", "Content-Type": "application/json" },
    ...(payload ? { body: JSON.stringify(payload) } : {}),
  });
  assert.ok(response.ok, await response.clone().text());
  return response.status === 204 ? null : response.json();
}
async function until(read, matches) {
  const deadline = Date.now() + 45000;
  let value;
  do {
    value = await read();
    if (matches(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  throw Error("Timed out waiting for project state: " + JSON.stringify(value.jobs?.map(j => [j.status, j.errorDetails])));
}
assert.ok((await call("/api/creation-test-health")).httpGenerationFixture);
const picture = spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=1024x1024",
  "-frames:v", "1", "-threads", "1", "-f", "image2pipe", "-c:v", "png", "pipe:1"]);
assert.equal(picture.status, 0);
const posts = [];
const service = createServer(async (req, res) => {
  if (req.url !== "/v1/images/generations") { res.writeHead(404).end(); return; }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  posts.push(JSON.parse(Buffer.concat(chunks)));
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [{ b64_json: picture.stdout.toString("base64") }] }));
});
service.listen(0, "127.0.0.1");
await once(service, "listening");
const browser = await launchBrowser();
let model, translator;
try {
  model = await call("/api/model-configs", { kind: "image", modelId: "review-image", url: `http://127.0.0.1:${service.address().port}/v1`,
    authMode: "none", connectionType: "api", protocol: "openai", capabilityAutoCheck: false });
  translator = await call("/api/model-configs", { kind: "agent", modelId: "review-translation", url: `http://127.0.0.1:${service.address().port}/v1`,
    authMode: "none", connectionType: "api", protocol: "openai", capabilityAutoCheck: false });
  for (const locale of ["zh-CN", "en-US"]) {
    const en = locale === "en-US", pid = crypto.randomUUID(), path = `/api/creation/projects/${pid}`;
    await call(path + "/commands", { type: "project.create", commandId: crypto.randomUUID(), projectId: pid, payload: { name: "Spend " + pid.slice(0, 8) } });
    const page = await browser.newPage({ locale, viewport: { width: 1480, height: 940 } });
    page.setDefaultTimeout(20000);
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(locale => {
      localStorage.setItem("opendirector.locale.v1", locale);
      localStorage.setItem("opendirector.theme.v1", locale === "en-US" ? "light" : "dark");
      localStorage.setItem("opendirector.modelSetup.v1", "dismissed");
    }, locale);
    await page.goto(`${web}/ai-tool/ai-canvas/${pid}`);
    await page.getByRole("button", {name: en ? "Settings" : "设置", exact: true}).click();
    await page.getByRole("button", {name: en ? "Model connections" : "模型接入", exact: true}).click();
    await page.locator(".cw-model-setup-row").filter({hasText: en ? "Image model" : "图片模型"}).getByRole("button").click();
    for (const [connection, rate] of [[model, "0.40"], [translator, "0.03"]]) {
      const label = en ? "Unit price" : "单价";
      const helper = connection.id === translator.id;
      if (helper) await page.locator(".cw-model-categories").getByRole("button", {name: en ? "Chat" : "对话", exact: true}).click();
      const serviceCard = page.locator(".cw-model-service").filter({has: page.locator(".cw-model-chip", {hasText: connection.modelId})});
      await serviceCard.locator("summary").filter({hasText: helper ? (en ? "Media tool call price" : "媒体工具调用单价") : label}).click();
      const form = serviceCard.locator(".cw-spend-form").filter({hasText: connection.modelId});
      await form.getByLabel(label, {exact: true}).fill(rate);
      await form.getByRole("button", {name: en ? "Save" : "保存", exact: true}).click();
      await form.getByRole("status").filter({hasText: en ? "Saved" : "已保存"}).waitFor();
      const saved = (await call("/api/model-configs")).find(value => value.id === connection.id);
      assert.equal(Number(saved.price.rate), Number(rate));
      assert.equal(saved.price.unit, "request");
      assert.equal(saved.price.currency, "USD");
    }
    await page.getByRole("button", {name: en ? "Close settings" : "关闭设置", exact: true}).click();
    const toggle = page.locator(".cw-spend-toggle");
    const dialog = page.locator("dialog.cw-spend-dialog[open]");
    const closeDialog = () => dialog.locator(".cw-spend-close").click();
    const collapsed = page.locator('.cw-spend-toggle[aria-expanded="false"]');
    assert.equal(await toggle.innerText(), "");
    const size = await toggle.boundingBox();
    const settingsSize = await page.getByRole("button", {name: en ? "Settings" : "设置", exact: true}).boundingBox();
    assert.deepEqual([size.width, size.height], [settingsSize.width, settingsSize.height]);
    await toggle.click();
    await page.getByText(en ? "Spending controls" : "费用设置", { exact: true }).click();
    await page.getByLabel(en ? "Confirm above" : "单批确认阈值").fill("1");
    await page.getByRole("button", { name: en ? "Save" : "保存", exact: true }).click();
    await until(() => call(path), s => Number(s.project.spendPolicy?.threshold) === 1);
    await closeDialog();
    const itemId = await page.evaluate(async ({ pid, modelId }) => {
      const { creationClient } = await import("/src/backend/creationClient.ts");
      const specId = crypto.randomUUID(), itemId = crypto.randomUUID();
      await creationClient(pid).command("canvas.createGeneration", {
        spec: { id: specId, projectId: pid, kind: "image", purpose: "generation", modelConfigId: modelId, prompt: "Blue", parameters: { size: "1024x1024" } },
        item: { id: itemId, projectId: pid, kind: "image", position: { x: 0, y: 0 }, binding: { role: "generation", objectRef: { id: specId } } },
      });
      return itemId;
    }, { pid, modelId: model.id });
    await page.locator(`.react-flow__node[data-id="${itemId}"]`).click();
    const composer = page.locator(".cw-generation-composer");
    // Let the real quotation reach the browser between pointer down and pointer up.
    let releaseQuote;
    const waitForRelease = new Promise(resolve => { releaseQuote = resolve; });
    const quotePath = "**" + path + "/queries";
    const isBatchQuote = request => {
      const body = request.postDataJSON();
      return body?.type === "generation.quote" && body.count === 3;
    };
    await page.route(quotePath, async route => {
      if (!isBatchQuote(route.request())) return route.continue();
      const response = await route.fetch();
      await waitForRelease;
      await route.fulfill({response});
    });
    const pendingQuote = page.waitForRequest(request => request.url().endsWith(path + "/queries") && isBatchQuote(request));
    await composer.locator(".cw-parameter-trigger").click();
    await page.locator(".cw-count-options").getByRole("button", { name: "3", exact: true }).click();
    await composer.locator(".cw-parameter-trigger").click();
    await pendingQuote;
    const run = composer.locator("button.cw-run-button");
    await run.click({trial: true});
    const initial = await run.boundingBox();
    await page.mouse.move(initial.x + initial.width / 2, initial.y + initial.height / 2);
    const before = posts.length;
    await page.mouse.down();
    releaseQuote();
    await composer.locator(".cw-spend-estimate summary").filter({ hasText: "1.20" }).waitFor();
    const quoted = await run.boundingBox();
    await page.mouse.up();
    const movement = Math.hypot(quoted.x - initial.x, quoted.y - initial.y);
    assert.ok(movement <= 1, `Run moved by ${movement}px as the quote arrived`);
    await page.unroute(quotePath);
    await dialog.waitFor();
    await toggle.locator(".cw-spend-dot").waitFor();
    if (process.env.CREATION_SCREENSHOTS && await composer.isVisible())
      await composer.screenshot({path: `${process.env.CREATION_SCREENSHOTS}/spend-composer-${locale}.png`});
    const pending = await call(path);
    assert.equal(pending.jobs.length, 0);
    assert.equal(pending.spendCalls?.length ?? 0, 0);
    assert.equal(posts.length, before);
    const controls = dialog;
    const canvasCard = dialog.locator(".cw-spend-card");
    await canvasCard.waitFor();
    assert.equal(await page.locator("dialog:modal").count(), 1);
    assert.equal(await dialog.locator(".cw-spend-close").evaluate(el => el === document.activeElement), true);
    await page.keyboard.press("Shift+Tab");
    // Native dialogs may tab into browser chrome, but never into the inert canvas.
    assert.equal(await dialog.evaluate(el => document.activeElement === document.body || el.contains(document.activeElement)), true);
    await page.keyboard.press("Tab");
    assert.equal(await dialog.evaluate(el => el.contains(document.activeElement)), true);
    await page.keyboard.press("Escape");
    await collapsed.waitFor();
    await toggle.click();
    await closeDialog();
    await collapsed.waitFor();
    assert.equal(await toggle.evaluate(el => el === document.activeElement), true);
    // Background project refreshes must not reopen a dismissed request or fill a new chat.
    await page.evaluate(async pid => {
      const { creationClient } = await import("/src/backend/creationClient.ts");
      await creationClient(pid).refresh();
    }, pid);
    await collapsed.waitFor();
    const assistant = page.locator("#canvas-assistant");
    if (!await assistant.isVisible()) await page.locator(".cw-chat-button").click();
    await assistant.locator(".cw-assistant-welcome").waitFor();
    assert.equal(await assistant.locator(".cw-spend-card, .cw-spend-panel").count(), 0);
    if (process.env.CREATION_SCREENSHOTS) await page.screenshot({path: `${process.env.CREATION_SCREENSHOTS}/spend-chat-${locale}.png`});
    assert.equal((await call(path)).spendRequests.at(-1).status, "pending");
    assert.equal(posts.length, before);
    // A review can arrive while a canvas popover owns a document-level Escape handler.
    await composer.locator(".cw-parameter-trigger").click();
    await page.locator(".cw-count-options").waitFor();
    await page.evaluate(pid => window.dispatchEvent(new CustomEvent("opendirector:spend-review", {detail: pid})), pid);
    await canvasCard.waitFor();
    await page.keyboard.press("Escape");
    await collapsed.waitFor();
    await page.locator(".cw-count-options").waitFor();
    await composer.locator(".cw-parameter-trigger").click();
    await toggle.click();
    await canvasCard.locator(".cw-spend-confirm").click();
    await collapsed.waitFor();
    await page.locator(".cw-toast-stack").getByText(en ? "Batch submitted." : "本批任务已提交。", {exact: true}).waitFor();
    const completed = await until(() => call(path), s => s.jobs.length === 3 && s.jobs.every(j => j.status === "succeeded"));
    assert.equal(completed.spendCalls.length, 3);
    assert.equal(new Set(completed.jobs.map(job => job.id)).size, 3);
    assert.equal(posts.length - before, 3);
    assert.ok(posts.slice(before).every(post => post.prompt === "Blue" && post.n === 1));
    assert.ok(completed.spendCalls.every(c => c.state === "completed" && Number(c.calculated) === 0.4));
    // Put the next batch above the remaining cap. A background request must wait
    // for model settings to close before asking for approval.
    await toggle.click();
    const cap = controls.getByLabel(en ? "Project cap" : "工程上限", {exact: true});
    if (!await cap.isVisible()) await controls.getByText(en ? "Spending controls" : "费用设置", {exact:true}).click();
    await cap.fill("2");
    await controls.getByRole("button", {name: en ? "Save" : "保存", exact: true}).click();
    await until(() => call(path), s => Number(s.project.spendPolicy?.cap) === 2);
    await closeDialog();
    await page.getByRole("button", {name: en ? "Settings" : "设置", exact: true}).click();
    const second = () => page.evaluate(async ({pid, itemId}) => {
      const {creationClient} = await import("/src/backend/creationClient.ts");
      return creationClient(pid).submit(itemId, "if_current", undefined, undefined, 3);
    }, {pid, itemId});
    assert.equal((await second()).status, "awaiting_confirmation");
    await page.locator("dialog.cw-spend-dialog:not([open])").waitFor({state: "attached"});
    assert.equal(await page.locator("dialog:modal").count(), 1);
    await page.getByRole("button", {name: en ? "Close settings" : "关闭设置", exact: true}).click();
    const card = dialog.locator(".cw-spend-card");
    await card.getByText(en ? "Generate 3 images" : "生成 3 张图片", {exact: true}).waitFor();
    assert.match(await card.locator(".cw-spend-unit").innerText(), /0\.40.*review-image/);
    assert.match(await card.locator(".cw-spend-amount").innerText(), /1\.20/);
    assert.match(await card.locator(".cw-spend-reason").innerText(), /0\.80.*0\.40/);
    const sizes = await card.evaluate(el => {
      const size = selector => getComputedStyle(el.querySelector(selector)).fontSize;
      return {
        title: size(".cw-spend-title"), amount: size(".cw-spend-amount"),
        unit: size(".cw-spend-unit"), reason: size(".cw-spend-reason"),
        balance: size(".cw-spend-metric strong"), action: size(".cw-spend-confirm"),
      };
    });
    assert.equal(sizes.title, sizes.amount);
    assert.deepEqual([sizes.unit, sizes.reason, sizes.balance], Array(3).fill(sizes.action));
    await card.getByRole("button", {name: en ? /Spent so far/ : /已用金额/}).hover();
    const tooltip = dialog.getByRole("tooltip");
    await tooltip.waitFor();
    assert.match(await tooltip.innerText(), /3.*1\.20/);
    const tip = await tooltip.boundingBox();
    assert.ok(tip.x >= 0 && tip.y >= 0 && tip.x + tip.width <= 1480 && tip.y + tip.height <= 940);
    await card.locator(".cw-spend-title").hover();
    await tooltip.waitFor({state: "hidden"});
    // Queue another request while this one is open; there is still only one modal.
    const third = await second();
    assert.equal(third.status, "awaiting_confirmation");
    assert.equal(await page.locator("dialog:modal").count(), 1);
    await card.locator(".cw-spend-cancel").click();
    await until(() => call(path), s => s.spendRequests.at(-2).status === "cancelled");
    assert.equal(posts.length - before, 3);
    const current = dialog.locator(`[data-spend-request="${third.spendRequestId}"]`);
    const raise = current.getByRole("button", {name: en ? /Raise.*2\.40.*generate/i : /将上限提高到.*2\.40.*并生成/});
    await raise.waitFor();
    assert.equal(await current.getByRole("spinbutton").count(), 0);
    if (process.env.CREATION_SCREENSHOTS) {
      await page.screenshot({path: `${process.env.CREATION_SCREENSHOTS}/spend-review-${locale}.png`});
      await dialog.screenshot({path: `${process.env.CREATION_SCREENSHOTS}/spend-card-${locale}.png`});
    }
    await page.setViewportSize({width: 360, height: 740});
    const bounds = await dialog.boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 360 && bounds.y >= 0 && bounds.y + bounds.height <= 740);
    assert.equal(await dialog.evaluate(el => el.scrollWidth > el.clientWidth), false);
    await raise.scrollIntoViewIfNeeded();
    if (process.env.CREATION_SCREENSHOTS) await page.screenshot({path: `${process.env.CREATION_SCREENSHOTS}/spend-narrow-${locale}.png`});
    await page.setViewportSize({width: 1480, height: 940});
    await raise.click();
    await collapsed.waitFor();
    assert.equal(await assistant.locator(".cw-spend-card, .cw-spend-panel").count(), 0);
    const raised = await until(() => call(path), s => s.jobs.length === 6 && s.jobs.every(j => j.status === "succeeded"));
    assert.equal(Number(raised.project.spendPolicy.cap), 2.4);
    assert.equal(raised.spendCalls.length, 6);
    assert.equal(posts.length - before, 6);
    assert.deepEqual(errors, []);
    console.log(locale, `Run moved ${movement}px; icon matches toolbar, automatic modal, focus, dismiss/reopen, unchanged new chat, queued review, narrow layout, USD 2.40 cap and six settled calls`);
    const grouped = crypto.randomUUID(), groupPath = `/api/creation/projects/${grouped}`;
    await call(groupPath + "/commands", {type: "project.create", commandId: crypto.randomUUID(), projectId: grouped, payload: {name: "Workflow " + grouped.slice(0, 8)}});
    await page.goto(`${web}/ai-tool/ai-canvas/${grouped}`);
    await page.locator(".cw-spend-toggle").waitFor();
    const groupId = await page.evaluate(async ({pid, modelId}) => {
      const {creationClient, objectVersion} = await import("/src/backend/creationClient.ts");
      const client = creationClient(pid), groupId = crypto.randomUUID();
      await client.command("canvas.show", {item: {id: groupId, projectId: pid, kind: "group", title: "Workflow", width: 820, height: 420, position: {x: 0, y: 0}}});
      for (const [i, prompt] of ["First panel", "Second panel"].entries()) {
        const specId = crypto.randomUUID();
        const parent = client.snapshot.canvasItems.find(item => item.id === groupId);
        await client.command("canvas.createGeneration", {
          spec: {id: specId, projectId: pid, kind: "image", purpose: "generation", modelConfigId: modelId, prompt, parameters: {size: "1024x1024"}},
          item: {id: crypto.randomUUID(), projectId: pid, kind: "image", parentId: groupId, position: {x: 60 + i * 360, y: 80},
            binding: {role: "generation", objectRef: {id: specId}}},
        }, [objectVersion("canvas_item", parent)]);
      }
      return groupId;
    }, {pid: grouped, modelId: model.id});
    const groupNode = page.locator(`.react-flow__node[data-id="${groupId}"]`);
    await groupNode.click({position: {x: 12, y: 14}});
    await page.locator(".cw-group-estimate summary").filter({hasText: "0.80"}).click();
    assert.match(await page.locator(".cw-group-estimate summary").innerText(), en ? /Project total.*0\.80/ : /工程预计合计.*0\.80/);
    assert.equal(await page.locator(".cw-group-estimate li").count(), 2);
    if (process.env.CREATION_SCREENSHOTS) await page.screenshot({path: `${process.env.CREATION_SCREENSHOTS}/spend-workflow-${locale}.png`});
    assert.equal((await call(groupPath)).jobs.length, 0);
    assert.equal(posts.length - before, 6);
    await page.evaluate(async pid => {
      const {creationClient, objectVersion} = await import("/src/backend/creationClient.ts");
      const client = creationClient(pid);
      await client.command("spend.policy", {threshold: "0.60", currency: "USD"}, [objectVersion("project", client.snapshot.project)]);
    }, grouped);
    await page.getByRole("button", {name: en ? "Run workflow" : "运行工作流", exact: true}).click();
    const groupPending = await until(() => call(groupPath), s => s.spendRequests?.some(r => r.status === "pending"));
    assert.equal(groupPending.spendRequests.at(-1).groupItems.length, 2);
    assert.equal(groupPending.jobs.length, 0);
    await dialog.waitFor();
    await canvasCard.locator(".cw-spend-cancel").click();
    await collapsed.waitFor();
    await until(() => call(groupPath), s => s.spendRequests.at(-1).status === "cancelled");
    assert.equal(posts.length - before, 6);
    assert.deepEqual(errors, []);
    console.log(locale, "two-step workflow preview USD 0.80, entire workflow cancelled with zero calls");
    if (en) {
      const session = await page.evaluate(() => sessionStorage.getItem("opendirector.session.v1"));
      const cli = (args, input) => new Promise((resolve, reject) => {
        const child = execFile(process.env.PYTHON ?? "python", ["-m", "opendirector.cli", "--url", api, "--project", grouped,
          "--session", session, ...args], {encoding: "utf8", timeout: 20000}, (error, stdout, stderr) => {
          if (error) reject(new Error(stderr || stdout || error.message));
          else resolve(stdout);
        });
        child.stdin.end(JSON.stringify(input));
      }).then(JSON.parse);
      const saved = await call(groupPath);
      const spec = saved.generationSpecs[0], item = saved.canvasItems.find(i => i.binding.objectRef?.id === spec.id);
      const quote = await cli(["query", "generation.quote", "--file", "-"], {specId: spec.id, originItemId: item.id, count: 3});
      assert.equal(Number(quote.amount), 1.2);
      const body = {expectedVersions: [{objectType:"canvas_item", id:item.id, revision:item.revision}, {objectType:"generation_spec", id:spec.id, revision:spec.revision}],
        payload:{specId:spec.id, expectedSpecRevision:spec.revision, originItemId:item.id, count:3}};
      const args = ["--operation-id", crypto.randomUUID(), "generation", "submit", "--file", "-"];
      const waiting = await cli(args, body);
      assert.equal(waiting.status, "awaiting_confirmation");
      assert.equal((await cli(args, body)).spendRequestId, waiting.spendRequestId);
      assert.ok(waiting.reviewUrl.endsWith(`/ai-tool/ai-canvas/${grouped}?spendReview=${waiting.spendRequestId}`));
      // Release the editing lease before opening the CLI link in a fresh browser session.
      await page.evaluate(async () => (await import("/src/backend/projects.ts")).releaseBackendProject());
      await page.goto("about:blank");
      const reviewPath = new URL(waiting.reviewUrl, web);
      const reviewPage = await browser.newPage({locale: "en-US"});
      await reviewPage.goto(web + reviewPath.pathname + reviewPath.search);
      const selector = `dialog.cw-spend-dialog[open] [data-spend-request="${waiting.spendRequestId}"]`;
      const welcome = reviewPage.locator("dialog.cw-welcome[open]");
      await welcome.waitFor();
      assert.equal(await reviewPage.locator(selector).count(), 0, "Review waits until initial setup finishes");
      await welcome.getByRole("button", {name: "Get started", exact: true}).click();
      await welcome.getByRole("button", {name: "Set up a language model", exact: true}).click();
      await welcome.getByRole("button", {name: "review-translation Use this saved language model", exact: true}).click();
      await welcome.getByRole("checkbox", {name: "Generate an image", exact: true}).check();
      const imagePicker = welcome.getByRole("combobox", {name: "Choose a text-to-image model", exact: true});
      if (await imagePicker.count()) await imagePicker.selectOption(model.id);
      await welcome.getByRole("button", {name: "Start creating", exact: true}).click();
      await welcome.waitFor({state: "hidden"});
      await reviewPage.locator(selector).getByRole("button", {name: "Cancel generation"}).click();
      await until(() => call(groupPath), s => s.spendRequests.at(-1).status === "cancelled");
      await reviewPage.close();
      assert.equal((await call(groupPath)).jobs.length, 0);
      assert.equal(posts.length - before, 6);
      console.log("Standalone CLI over HTTP: USD 1.20, replayed request, browser cancellation and zero calls");
    }
    await page.close();
  }
} finally {
  await browser.close();
  service.close();
  for (const connection of [model, translator]) {
    if (connection) await call(`/api/model-configs/${connection.id}`, null, "DELETE");
  }
}
