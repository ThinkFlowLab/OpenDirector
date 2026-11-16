/** A stored editor delivery that the backend definitively refuses (422) must
 * not replay forever: the Director Stage recovers on the next attempt. */
import assert from "node:assert/strict";
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE ?? "playwright-core"
);

const base = process.env.CREATION_WEB_URL ?? "http://127.0.0.1:5179";
const api = process.env.CREATION_API_URL ?? "http://127.0.0.1:8019";
const headers = {
  "X-OpenDirector-Request": "1",
  "Content-Type": "application/json",
};
async function call(path, body) {
  const response = await fetch(api + path, {
    headers,
    ...(body ? { method: "POST", body: JSON.stringify(body) } : {}),
  });
  assert.ok(response.ok, `${response.status}: ${await response.clone().text()}`);
  return response.json();
}
assert.equal((await call("/api/creation-test-health")).isolated, true);

const projectId = crypto.randomUUID();
await call(`/api/creation/projects/${projectId}/commands`, {
  commandId: crypto.randomUUID(),
  projectId,
  type: "project.create",
  payload: { name: `Stage delivery ${projectId.slice(0, 8)}` },
});
const state = () => call(`/api/creation/projects/${projectId}`);

const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  args: ["--no-sandbox", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage({
  locale: "en-US",
  viewport: { width: 1700, height: 1100 },
});
await page.addInitScript(() =>
  localStorage.setItem("opendirector.modelSetup.v1", "dismissed"),
);
page.setDefaultTimeout(20000);
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));

const until = async (predicate, label) => {
  const deadline = Date.now() + 20000;
  let snapshot;
  while (Date.now() < deadline) {
    snapshot = await state();
    if (predicate(snapshot)) return snapshot;
    await page.waitForTimeout(100);
  }
  throw new Error(`Timeout: ${label}`);
};

try {
  await page.goto(`${base}/ai-tool/ai-canvas/${projectId}?creation=unified`);
  await page.getByText("Saved on this device", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Add Director Stage", exact: true }).click();
  await page.getByRole("button", { name: "Apply edits", exact: true }).waitFor();
  // Baseline save registers the editor document; the delivery key needs the item.
  await page.getByRole("button", { name: "Apply edits", exact: true }).click();
  const applied = await until(
    (snapshot) => snapshot.editorDocuments.some((d) => d.kind === "director"),
    "stage saved",
  );
  const itemId = applied.canvasItems.find((i) => i.kind === "external").id;
  const documentId = applied.editorDocuments.find((d) => d.kind === "director").id;
  await page.getByRole("button", { name: "Add Director Stage", exact: true }).waitFor();

  // Poison the stored delivery the way a mid-transition failure leaves it: a
  // prepared plan whose operations the backend now refuses at the HTTP
  // boundary. A reload keeps the entry, exactly like a long-lived tab.
  await page.evaluate(
    ([projectId, itemId]) => {
      sessionStorage.setItem(
        `opendirector.editor.delivery:${projectId}:${itemId}`,
        JSON.stringify({
          id: crypto.randomUUID(),
          key: JSON.stringify({ title: "Director Stage 1" }),
          data: { title: "Director Stage 1" },
          plan: {
            operations: [
              {
                type: "editor.save",
                payload: {
                  document: {
                    id: crypto.randomUUID(),
                    projectId,
                    kind: "director",
                    data: { legacyJunk: true },
                  },
                },
              },
            ],
            versions: [],
          },
        }),
      );
    },
    [projectId, itemId],
  );
  await page.reload();
  await page.getByText("Saved on this device", { exact: true }).waitFor();

  await page.locator(`.react-flow__node[data-id="${itemId}"]`).click();
  await page.getByRole("button", { name: "Open Director Stage", exact: true }).click();
  await page.getByRole("button", { name: "Apply edits", exact: true }).waitFor();

  // The refused delivery may cost one attempt — the reported error dialog —
  // but never more: rendering must recover without discarding the edits.
  const render = page.getByRole("button", { name: "Render preview MP4", exact: true });
  await render.click();
  const recovered = await page
    .getByText("Preview MP4 complete · 1280×720 · 30 fps", { exact: true })
    .waitFor({ timeout: 240000 })
    .then(() => true, () => false);
  if (!recovered) {
    // The single refusal surfaced; the retry replans with current code.
    await page.getByRole("alert").waitFor();
    assert.equal(await render.isDisabled(), false, "editor stays operable");
    await render.click();
    await page
      .getByText("Preview MP4 complete · 1280×720 · 30 fps", { exact: true })
      .waitFor({ timeout: 240000 });
  }

  // Applying also recovers: the same stored delivery cannot block the commit.
  await page.getByRole("button", { name: "Apply edits", exact: true }).click();
  await page
    .getByRole("button", { name: "Add Director Stage", exact: true })
    .waitFor();
  await until(
    (snapshot) =>
      snapshot.editorDocuments.some(
        (d) => d.id === documentId && d.revision >= 2,
      ),
    "stage committed after recovery",
  );

  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      passed: true,
      projectId,
      itemId,
      documentId,
      checks: [
        "a refused stored delivery costs at most one attempt",
        "the retry replans instead of replaying the refused operations",
        "preview MP4 renders and apply recovers",
        "no page errors",
      ],
    }),
  );
} catch (error) {
  console.error((await page.locator("body").innerText()).slice(-2500));
  throw error;
} finally {
  await browser.close();
}
