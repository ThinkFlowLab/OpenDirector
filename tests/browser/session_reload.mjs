/** Reload with lost cleanup, then deliver the old lifecycle packets late. */
import assert from "node:assert/strict";
import { launchBrowser } from "./engine.mjs";

const api = process.env.CREATION_API_URL ?? "http://127.0.0.1:8019";
const base = process.env.CREATION_WEB_URL ?? "http://127.0.0.1:5179";
const common = {
  "X-OpenDirector-Request": "1",
  "Content-Type": "application/json",
};
const browser = await launchBrowser();
try {
  for (const locale of ["en-US", "zh-CN"]) {
    const id = crypto.randomUUID();
    const created = await fetch(`${api}/api/creation/projects/${id}/commands`, {
      method: "POST",
      headers: common,
      body: JSON.stringify({
        commandId: crypto.randomUUID(),
        projectId: id,
        type: "project.create",
        payload: { name: `Reload ${locale} ${id.slice(0, 8)}` },
      }),
    });
    assert.equal(created.status, 200, await created.text());
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await context.addInitScript((locale) => {
      localStorage.setItem("opendirector.modelSetup.v1", "dismissed");
      localStorage.setItem("opendirector.locale.v1", locale);
      const original = window.fetch.bind(window);
      window.fetch = (input, options) => {
        // Deterministically lose pagehide cleanup instead of relying on unload timing.
        if (
          options?.method === "DELETE" &&
          String(input).includes("/creation/sessions/")
        )
          return Promise.resolve(new Response("{}", { status: 200 }));
        return original(input, options);
      };
    }, locale);
    const saved = locale === "en-US" ? "Saved on this device" : "已保存到本机";
    const openResponse = () =>
      page.waitForResponse(
        (response) =>
          response.url().endsWith(`/projects/${id}/open-canvas`) &&
          response.request().method() === "POST",
      );
    let opening = openResponse();
    await page.goto(`${base}/ai-tool/ai-canvas/${id}?creation=unified`, {
      waitUntil: "domcontentloaded",
    });
    let response = await opening;
    assert.equal(response.status(), 200);
    await page.getByText(saved, { exact: true }).waitFor();
    let current = response.request().headers();
    const owner = current["x-opendirector-session"];
    for (let reload = 0; reload < 3; reload++) {
      const old = current;
      opening = openResponse();
      await page.reload({ waitUntil: "domcontentloaded" });
      response = await opening;
      assert.equal(response.status(), 200);
      current = response.request().headers();
      assert.equal(current["x-opendirector-session"], owner);
      assert.ok(
        Number(current["x-opendirector-session-generation"]) >
          Number(old["x-opendirector-session-generation"]),
      );
      await page.getByText(saved, { exact: true }).waitFor();
      const sessionUrl = `${api}/api/creation/sessions/${owner}`;
      const lifecycleHeaders = (wire) => ({
        ...common,
        "X-OpenDirector-Session-Generation":
          wire["x-opendirector-session-generation"],
      });
      // Replay the previous document's actual wire identity after handoff.
      assert.equal(
        (
          await fetch(sessionUrl, {
            method: "DELETE",
            headers: lifecycleHeaders(old),
          })
        ).status,
        200,
      );
      const stale = await fetch(sessionUrl, {
        method: "PUT",
        headers: lifecycleHeaders(old),
        body: JSON.stringify({ projectId: id }),
      });
      assert.equal(stale.status, 409);
      assert.equal((await stale.json()).code, "session_stale");
      assert.equal(
        (
          await fetch(sessionUrl, {
            method: "PUT",
            headers: lifecycleHeaders(current),
            body: JSON.stringify({ projectId: id }),
          })
        ).status,
        200,
      );
    }
    // window.open copies sessionStorage; a normal new navigation must still
    // get its own owner and cannot steal the original window's live project.
    const popupPromise = context.waitForEvent("page");
    await page.evaluate(() => window.open(location.href, "_blank"));
    const popup = await popupPromise;
    const blocked = await popup.waitForResponse(
      (response) =>
        response.url().endsWith(`/projects/${id}/open-canvas`) &&
        response.status() === 409,
    );
    assert.notEqual(
      blocked.request().headers()["x-opendirector-session"],
      owner,
    );
    assert.equal((await blocked.json()).code, "storage_busy");
    await popup.close();
    await page
      .getByRole("toolbar", {
        name: locale === "en-US" ? "Canvas creation tools" : "画布创作工具",
      })
      .getByRole("button", {
        name: locale === "en-US" ? "Add Audio" : "添加音频",
        exact: true,
      })
      .click();
    await page.getByText(saved, { exact: true }).waitFor();
    // The restored editor must still commit actual project content.
    for (let attempt = 0; ; attempt++) {
      const state = await (
        await fetch(`${api}/api/creation/projects/${id}`, { headers: common })
      ).json();
      if (state.generationSpecs.length === 1) break;
      assert.ok(
        attempt < 100,
        "Reloaded editor did not persist its new audio node",
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.deepEqual(errors, []);
    await context.close();
    console.log(
      `PASS session reload ${locale}: lost cleanup, stale packets, independent popup and persisted edit`,
    );
  }
} finally {
  await browser.close();
}
