import assert from "node:assert/strict";
import { launchBrowser } from "./engine.mjs";

const base = process.env.CREATION_WEB_URL ?? "http://127.0.0.1:5179";
const headers = { "X-OpenDirector-Request": "1", "Content-Type": "application/json" };
const health = await fetch(base + "/api/creation-test-health", { headers });
assert.ok(health.ok && (await health.json()).isolated, "Requires an isolated creation API");

const projectId = crypto.randomUUID();
const projectPath = `/api/creation/projects/${projectId}`;
const create = await fetch(base + projectPath + "/commands", {
  method: "POST", headers,
  body: JSON.stringify({
    projectId, commandId: crypto.randomUUID(), type: "project.create",
    payload: { name: `First-run journey ${projectId.slice(0, 8)}` },
  }),
});
assert.ok(create.ok, await create.text());

const browser = await launchBrowser();
const configuredIds = [];
try {
  const page = await browser.newPage({ locale: "en-US", viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const codex = {
    id: "codex", label: "Codex", group: "harness", modelSource: "cli",
    modelOverride: true, available: true, status: "ready",
  };
  const claude = { ...codex, id: "claude", label: "Claude Code", status: "needs_login" };
  const defaultAgent = { ...codex, id: "default", label: "Default", group: "default", modelSource: "settings", modelOverride: false };
  const slowHarness = { ...codex, id: "deepseek", label: "DeepSeek Harness", status: "checking" };
  const probe = Promise.withResolvers();
  await page.route("**/assistant/runtimes/deepseek/status", async (route) => {
    await probe.promise;
    await route.fulfill({ json: { ...slowHarness, status: "unknown" } }).catch(() => {});
  });
  await page.route(/\/assistant\/runtimes\?probe=false$/, (route) =>
    route.fulfill({ json: [slowHarness, { ...codex, status: "checking" }, claude] }));
  await page.route(/\/assistant\/runtimes\/(codex|claude)\/status$/, (route) =>
    route.fulfill({ json: route.request().url().includes("codex") ? codex : claude }));
  await page.route("**/assistant/runtimes/default/status", (route) => route.fulfill({ json: defaultAgent }));
  const languageModel = `first-run-agent-${projectId.slice(0, 8)}`;
  const videoModels = ["alpha", "beta"].map((suffix) => `first-run-video-${projectId.slice(0, 8)}-${suffix}`);
  const imageModel = `first-run-image-${projectId.slice(0, 8)}`;
  let failCatalog = true;
  let showBlockedImage = false;
  let blockedImage;
  await page.route(/\/api\/model-configs$/, async (route) => {
    if (failCatalog) {
      await route.fulfill({ status: 503, json: {} });
      return;
    }
    const response = await route.fetch();
    const configs = await response.json();
    const models = configs.filter((item) => item.modelId === languageModel ||
      videoModels.includes(item.modelId) || (!showBlockedImage && item.modelId === imageModel));
    if (showBlockedImage) {
      const image = configs.find((item) => item.modelId === "fixture-image");
      blockedImage = {
        ...image.availability,
        operations: [{
          profile: "text_to_image", operation: "generation", method: "POST",
          path: "/v1/images/generations", output: "image", status: "unavailable",
          reasonCode: "execution_paused", checkedAt: null, expiresAt: null,
        }],
      };
      models.push({ ...image, availability: blockedImage });
    }
    await route.fulfill({ response, json: models });
  });

  const url = `${base}/ai-tool/ai-canvas/${projectId}`;
  const welcome = page.locator("dialog.cw-welcome");
  const welcomeTitle = welcome.getByRole("heading", { name: "Welcome to OpenDirector" });
  const getStarted = welcome.getByRole("button", { name: "Get started" });
  const assistantTitle = welcome.getByRole("heading", { name: "Connect an LLM" });
  const chooseHarness = async () => {
    await welcome.getByRole("button", { name: "Use an existing harness", exact: true }).click();
    const codexButton = welcome.getByRole("button", { name: /^Codex/ });
    await codexButton.waitFor();
    assert.equal(await welcome.getByRole("button", { name: /^Claude Code/ }).isDisabled(), true);
    await codexButton.click();
    await welcome.getByRole("heading", { name: "What do you want to do first?" }).waitFor();
  };
  await page.goto(`${url}?setup=welcome&from=onboarding`);
  await welcomeTitle.waitFor();
  await welcome.getByRole("alert").getByText("Could not read model configuration. Try again.").waitFor();
  // The dev build can read the catalog twice before the user retries.
  failCatalog = false;
  await welcome.getByRole("button", { name: "Reload", exact: true }).click();
  await welcome.getByRole("alert").waitFor({ state: "hidden" });
  await welcome.getByText("Loading model configuration…").waitFor({ state: "hidden" });
  await page.keyboard.press("Escape");
  assert.ok(await welcomeTitle.isVisible());
  assert.equal(await assistantTitle.count(), 0);
  assert.equal(await welcome.getByRole("button").count(), 1);
  await page.setViewportSize({ width: 375, height: 640 });
  assert.ok(await getStarted.evaluate((element) => element.getBoundingClientRect().bottom <= window.innerHeight));
  await page.keyboard.press("Tab");
  assert.ok(await getStarted.evaluate((element) => document.activeElement === element));
  await page.keyboard.press("Enter");
  await assistantTitle.waitFor();
  await welcome.getByRole("button", { name: "Back", exact: true }).click();
  await welcomeTitle.waitFor();
  await page.setViewportSize({ width: 1440, height: 900 });
  await getStarted.click();
  await assistantTitle.waitFor();
  assert.equal(await welcome.getByRole("checkbox").count(), 0);

  const configureLanguage = welcome.getByRole("button", { name: "Set up a language model", exact: true });
  const serviceUrl = welcome.getByLabel("Service URL (Base URL)");
  const manualModelId = "Model ID (the service's served-model-name)";
  await configureLanguage.click();
  await serviceUrl.waitFor();
  assert.equal(await welcome.getByRole("button", { name: "Add a language model", exact: true }).count(), 0);
  await serviceUrl.press("Escape");
  await assistantTitle.waitFor();
  await configureLanguage.click();
  await serviceUrl.fill("http://127.0.0.1:12345/v1");
  await welcome.getByRole("button", { name: "Add manually" }).click();
  await welcome.getByLabel(manualModelId, { exact: true }).fill(languageModel);
  await welcome.getByRole("button", { name: "Add", exact: true }).click();
  let testAttempts = 0;
  await page.route("**/api/model-configs/test-agent", (route) => ++testAttempts === 1
    ? route.fulfill({ status: 401, json: { detail: "Fixture rejected the API key" } })
    : route.fulfill({ json: { elapsedMs: 150 } }));
  const testModel = welcome.getByRole("button", { name: `Test ${languageModel}` });
  await testModel.click();
  await welcome.getByText("Fixture rejected the API key").waitFor();
  const saveLanguage = welcome.getByRole("button", { name: "Save and continue", exact: true });
  assert.ok(await saveLanguage.isDisabled());
  assert.ok(await welcome.getByRole("heading", { name: "Set up a language model" }).isVisible());
  await testModel.click();
  await welcome.getByText("Passed in 0.15 s").waitFor();
  const languageSave = page.waitForResponse((response) => response.url().endsWith("/api/model-configs/batch"));
  await saveLanguage.click();
  const languageReceipt = await languageSave;
  assert.ok(languageReceipt.ok(), await languageReceipt.text());
  const [savedLanguage] = await languageReceipt.json();
  configuredIds.push(savedLanguage.id);
  await welcome.getByRole("heading", { name: "What do you want to do first?" }).waitFor();
  const languageAssistant = await page.request.get(base + projectPath + "/assistant", { headers });
  assert.ok(languageAssistant.ok(), await languageAssistant.text());
  assert.equal((await languageAssistant.json()).modelSelections.agent, savedLanguage.id);

  await welcome.getByRole("button", { name: "Back", exact: true }).click();
  await chooseHarness();
  probe.resolve();
  assert.equal(await welcome.getByRole("button", { name: "Continue" }).count(), 0);

  const assistant = await page.request.get(base + projectPath + "/assistant", { headers });
  assert.ok(assistant.ok(), await assistant.text());
  assert.equal((await assistant.json()).runtime, "codex");

  assert.equal(await welcome.getByRole("checkbox", { checked: true }).count(), 0);
  const videoTask = welcome.getByRole("checkbox", { name: "Make a video" });
  await page.setViewportSize({ width: 375, height: 720 });
  await videoTask.check();
  const videoForm = welcome.getByRole("heading", { name: "Set up a video model" });
  await videoForm.waitFor();
  assert.ok(await videoForm.evaluate((element) => element.getBoundingClientRect().bottom <= window.innerHeight));
  assert.match(await welcome.locator("[aria-current=step]").innerText(), /2\s*Choose a task/);
  await page.setViewportSize({ width: 1440, height: 900 });
  await welcome.getByLabel("Service URL (Base URL)").fill("http://127.0.0.1:12345/v1");
  for (const videoModel of videoModels) {
    await welcome.getByRole("button", { name: "Add manually" }).click();
    await welcome.getByLabel(manualModelId, { exact: true }).fill(videoModel);
    await welcome.getByRole("button", { name: "Add", exact: true }).click();
  }
  const saving = page.waitForResponse((response) => response.url().endsWith("/api/model-configs/batch"));
  await welcome.getByRole("button", { name: "Save service" }).click();
  const saved = await saving;
  assert.ok(saved.ok(), await saved.text());
  const savedModels = await saved.json();
  configuredIds.push(...savedModels.map((item) => item.id));
  const configured = savedModels.find((item) => item.modelId === videoModels[1]);
  assert.equal(configured.kind, "video");
  const videoPicker = welcome.getByRole("combobox", { name: "Choose a video model" });
  await videoPicker.waitFor();
  assert.ok(await videoTask.isChecked());
  const start = welcome.getByRole("button", { name: "Start creating" });
  assert.ok(await start.isDisabled());
  await videoPicker.selectOption(configured.id);
  await welcome.getByRole("button", { name: "Add a model", exact: true }).click();
  await welcome.getByRole("heading", { name: "Set up a video model" }).waitFor();
  await welcome.getByRole("button", { name: "Cancel", exact: true }).click();
  const imageTask = welcome.getByRole("checkbox", { name: "Generate an image" });
  await imageTask.press("Space");
  assert.ok(await imageTask.isChecked());
  assert.ok(await videoTask.isChecked());
  assert.ok(await start.isDisabled());
  const imageSetup = welcome.getByRole("region", { name: "Set up a text-to-image model" });
  const imageUrl = imageSetup.getByLabel("Service URL (Base URL)");
  await imageUrl.fill("http://127.0.0.1:12345/v1");
  await imageSetup.getByRole("button", { name: "Add manually" }).click();
  await imageSetup.getByLabel(manualModelId, { exact: true }).fill(imageModel);
  const speechTask = welcome.getByRole("checkbox", { name: "Create voice-over" });
  await speechTask.check();
  const speechSetup = welcome.getByRole("region", { name: "Set up a text-to-speech model" });
  await speechSetup.getByRole("button", { name: "Add manually" }).click();
  const speechInput = speechSetup.getByLabel(manualModelId, { exact: true });
  assert.notEqual(await speechInput.getAttribute("id"), await imageSetup.getByLabel(manualModelId, { exact: true }).getAttribute("id"));
  await speechInput.press("Escape");
  await speechSetup.getByRole("heading", { name: "Set up a text-to-speech model", exact: true }).waitFor({ state: "hidden" });
  assert.ok(await speechTask.isChecked());
  assert.equal(await imageUrl.inputValue(), "http://127.0.0.1:12345/v1");
  assert.equal(await imageSetup.getByLabel(manualModelId, { exact: true }).inputValue(), imageModel);
  await speechTask.uncheck();
  const musicTask = welcome.getByRole("checkbox", { name: "Create music" });
  await musicTask.check();
  const musicForm = welcome.getByRole("heading", { name: "Set up a music generation model" });
  await musicForm.waitFor();
  await musicTask.uncheck();
  await musicForm.waitFor({ state: "hidden" });
  await imageSetup.getByRole("button", { name: "Add", exact: true }).click();
  const imageSave = page.waitForResponse((response) => response.url().endsWith("/api/model-configs/batch"));
  await imageSetup.getByRole("button", { name: "Save service" }).click();
  const imageReceipt = await imageSave;
  assert.ok(imageReceipt.ok(), await imageReceipt.text());
  const [savedImage] = await imageReceipt.json();
  configuredIds.push(savedImage.id);
  const imagePicker = welcome.getByRole("combobox", { name: "Choose a text-to-image model" });
  assert.equal(await imagePicker.inputValue(), savedImage.id);
  assert.equal(await videoPicker.inputValue(), configured.id);
  const isFirstNodeRequest = (request) =>
    request.url().endsWith(projectPath + "/commands") &&
    request.method() === "POST" && request.postData()?.includes(configured.id);
  const dismissed = () => page.evaluate(() => localStorage.getItem("opendirector.modelSetup.v1"));
  const importing = page.waitForEvent("filechooser");
  await welcome.getByRole("button", { name: "Import media", exact: true }).click();
  await (await importing).setFiles([]);
  assert.equal(await dismissed(), null);
  assert.ok(await imageTask.isChecked());
  assert.equal(await videoPicker.inputValue(), configured.id);
  await page.route("**/api/example-canvases/video-canvas/download", (route) => route.fulfill({ status: 503 }));
  await welcome.getByRole("button", { name: "Open an example canvas", exact: true }).click();
  await welcome.getByRole("alert").filter({ hasText: "HTTP 503" }).waitFor();
  assert.equal(await page.locator(".cw-example-dialog").count(), 0);
  assert.equal(await dismissed(), null);
  assert.ok(await imageTask.isChecked());
  assert.equal(await videoPicker.inputValue(), configured.id);

  let rejectedPayload;
  await page.route("**" + projectPath + "/commands", (route) => {
    if (!rejectedPayload && isFirstNodeRequest(route.request())) {
      rejectedPayload = route.request().postDataJSON().payload;
      return route.fulfill({ status: 422, json: { detail: "Fixture rejected the first node" } });
    }
    return route.continue();
  });
  await start.click();
  await welcome.getByRole("alert").getByText("Fixture rejected the first node").waitFor();
  assert.ok(await videoTask.isChecked());
  assert.ok(await imageTask.isChecked());
  assert.equal(await videoPicker.inputValue(), configured.id);
  assert.equal(await page.locator(".react-flow__node").count(), 0);
  assert.equal(await dismissed(), null);
  assert.equal(new URL(page.url()).searchParams.get("setup"), "welcome");
  const savingNode = page.waitForRequest(isFirstNodeRequest);
  await start.click();
  const retried = await savingNode;
  assert.deepEqual(retried.postDataJSON().payload, rejectedPayload);
  const receipt = await retried.response();
  assert.ok(receipt?.ok(), await receipt?.text());
  await page.locator(".react-flow__node").first().waitFor();
  await welcome.waitFor({ state: "hidden" });
  assert.equal(await dismissed(), "dismissed");
  assert.equal(page.url(), `${base}/?from=onboarding`);
  const canvas = await page.request.get(base + projectPath + "/canvas", { headers });
  assert.ok(canvas.ok());
  const { snapshot } = await canvas.json();
  assert.deepEqual(snapshot.canvasItems.map((item) => item.kind).sort(), ["image", "video"]);
  assert.deepEqual(snapshot.generationSpecs.map((spec) => spec.modelConfigId).sort(), [configured.id, savedImage.id].sort());
  const [left, right] = [...snapshot.canvasItems].sort((a, b) => a.position.x - b.position.x);
  assert.ok(right.position.x >= left.position.x + left.width);

  await page.reload();
  await page.locator(".react-flow__node").first().waitFor();
  assert.equal(await welcome.isVisible(), false);

  showBlockedImage = true;
  await page.goto(url + "?setup=welcome");
  await getStarted.click();
  await chooseHarness();
  await imageTask.check();
  const blocked = welcome.getByRole("listitem").filter({ hasText: "fixture-image" });
  await blocked.getByText("Service paused").waitFor();
  assert.equal(await welcome.getByText("You still need a compatible text-to-image model.").count(), 0);
  await blocked.getByRole("button", { name: "Edit service", exact: true }).click();
  assert.ok(await welcome.getByRole("form", { name: "Edit service" }).isVisible());
  await welcome.getByRole("button", { name: "Cancel", exact: true }).press("Escape");
  await blocked.getByText("Service paused").waitFor();
  await page.route("**/api/model-configs/availability", (route) => route.fulfill({
    json: {
      models: [{
        ...blockedImage,
        operations: blockedImage.operations.map((operation) => ({ ...operation, status: "available", reasonCode: "available" })),
      }],
    },
  }));
  const recheck = page.waitForRequest((request) =>
    request.url().endsWith("/model-configs/availability") && request.postDataJSON()?.manual);
  await blocked.getByRole("button", { name: "Retry", exact: true }).click();
  await recheck;
  await welcome.getByRole("combobox", { name: "Choose a text-to-image model" }).waitFor();
  assert.deepEqual(errors, []);
  console.log("Browser first-run setup, cancellation, retry, and model availability passed");
} finally {
  await browser.close();
  for (const id of configuredIds) await fetch(base + "/api/model-configs/" + id, { method: "DELETE", headers });
}
