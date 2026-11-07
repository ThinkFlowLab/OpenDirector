/** Measure warm project switches against the isolated creation fixture. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { launchBrowser } from "./engine.mjs";

const web = process.env.CREATION_WEB_URL ?? "http://127.0.0.1:5179";
const api = process.env.CREATION_API_URL ?? "http://127.0.0.1:8019";
const headers = { "X-OpenDirector-Request": "1", "Content-Type": "application/json" };

async function checkFixture(url) {
  const response = await fetch(url + "/api/creation-test-health", { headers });
  assert.ok(response.ok, `Expected isolated fixture at ${url}`);
  const fixture = await response.json();
  assert.equal(fixture.isolated, true);
  return fixture.root;
}

assert.equal(await checkFixture(web), await checkFixture(api));
const projects = [];
for (const label of ["A", "B"]) {
  const id = crypto.randomUUID();
  const name = `Switch fixture ${label} ${id.slice(0, 8)}`;
  const response = await fetch(`${api}/api/creation/projects/${id}/commands`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      projectId: id, commandId: crypto.randomUUID(),
      type: "project.create", payload: { name },
    }),
  });
  assert.ok(response.ok, await response.text());
  projects.push({ id, name, label });
}

const browser = await launchBrowser();
try {
  const page = await browser.newPage({ locale: "en-US", viewport: { width: 1500, height: 1000 } });
  await page.addInitScript(() => {
    localStorage.setItem("opendirector.modelSetup.v1", "dismissed");
    document.addEventListener("click", (event) => {
      if (event.target.closest('[role="menuitemradio"].cw-project-option')) {
        performance.mark("canvas-switch-click");
        const previousTitle = document.querySelector(".cw-project-name")?.textContent;
        const deadline = performance.now() + 15000;
        function observeFeedback() {
          const workspace = document.querySelector(".cw-workspace");
          const title = document.querySelector(".cw-project-name")?.textContent;
          if (workspace?.getAttribute("aria-busy") === "true" || (title && title !== previousTitle)) {
            performance.mark("canvas-switch-feedback");
          } else if (performance.now() < deadline) {
            requestAnimationFrame(observeFeedback);
          }
        }
        requestAnimationFrame(observeFeedback);
      }
    }, true);
  });
  page.setDefaultTimeout(15000);
  const picker = page.getByRole("button", { name: "Switch project", exact: true });
  const ready = async (project) => {
    await page.locator(".cw-project-name").getByText(project.name, { exact: true }).waitFor();
    await page.getByText("Saved on this device", { exact: true }).waitFor();
    await picker.click({ trial: true });
  };
  await page.goto(`${web}/ai-tool/ai-canvas/${projects[0].id}`);
  await ready(projects[0]);
  const samples = [];
  for (let index = 0; index < 12; index++) {
    const target = projects[(index + 1) % 2];
    await page.evaluate(() => {
      performance.clearMarks("canvas-switch-click");
      performance.clearMarks("canvas-switch-feedback");
    });
    await picker.click();
    const [openResponse] = await Promise.all([
      page.waitForResponse((response) =>
        new URL(response.url()).pathname.endsWith(`/${target.id}/open-canvas`) && response.ok()),
      page.getByRole("menuitemradio", { name: target.name, exact: true }).click(),
    ]);
    await ready(target);
    const timing = await page.evaluate(() => {
      const start = performance.getEntriesByName("canvas-switch-click").at(-1);
      if (!start) throw new Error("Missing project selection click");
      const feedback = performance.getEntriesByName("canvas-switch-feedback").at(-1);
      if (!feedback) throw new Error("Missing switch feedback frame");
      return {
        clickEpochMs: performance.timeOrigin + start.startTime,
        feedbackMs: Math.round(feedback.startTime - start.startTime),
        readyMs: Math.round(performance.now() - start.startTime),
      };
    });
    await openResponse.finished();
    const network = openResponse.request().timing();
    const { clickEpochMs, ...elapsed } = timing;
    const beforeOpenMs = Math.round(network.startTime - clickEpochMs);
    const openMs = Math.round(network.responseEnd);
    if (index >= 2) samples.push({
      direction: target.label === "B" ? "A → B" : "B → A",
      ...elapsed,
      beforeOpenMs,
      openMs,
      queueMs: Math.round(network.requestStart),
      ttfbMs: Math.round(network.responseStart - network.requestStart),
      afterOpenMs: elapsed.readyMs - beforeOpenMs - openMs,
    });
  }
  const times = samples.map(({ readyMs }) => readyMs).sort((a, b) => a - b);
  const feedbackTimes = samples.map(({ feedbackMs }) => feedbackMs).sort((a, b) => a - b);
  // Project targets informed by NN/g's 100 ms and 1 s response-time guidance.
  const targets = { feedbackP90Ms: 100, readyMedianMs: 500, readyP90Ms: 1000 };
  const actual = { feedbackP90Ms: feedbackTimes[8], readyMedianMs: (times[4] + times[5]) / 2, readyP90Ms: times[8] };
  const meetsTarget = Object.fromEntries(
    Object.entries(targets).map(([metric, limit]) => [metric, actual[metric] <= limit]),
  );
  console.log(JSON.stringify({
    commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    environment: { platform: process.platform, arch: process.arch, node: process.version, browser: browser.version() },
    fixture: "Two empty, saved canvases. Two warm-up switches excluded.",
    metric: "Project selection click to target title, saved state and actionable project picker.",
    feedbackMetric: "First animation frame observing the switching state or the new project title. This is a paint proxy.",
    guidance: "https://www.nngroup.com/articles/response-times-3-important-limits/",
    targets,
    actual,
    meetsTarget,
    samples,
  }, null, 2));
} finally {
  await browser.close();
}
