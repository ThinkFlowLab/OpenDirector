import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";

export const zhipuBaseURL = "https://open.bigmodel.cn/api/paas/v4";
export const zhipuFixtureKey = "zhipu-browser-fixture-only-no-real-service";
export const zhipuModelsPath = `${new URL(zhipuBaseURL).pathname}/models`;

export async function startZhipuCatalog(page, readCatalog) {
  const requests = [];
  const server = createServer(async (request, response) => {
    const received = {
      method: request.method,
      path: request.url,
      authorized: request.headers.authorization === `Bearer ${zhipuFixtureKey}`,
    };
    requests.push(received);
    if (received.method !== "GET" || received.path !== zhipuModelsPath || !received.authorized) {
      response.writeHead(400).end();
      return;
    }
    const { status, ids, ready } = readCatalog();
    await ready;
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(JSON.stringify(status === 200 ? { data: ids.map(id => ({ id })) } : {}));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const fixtureURL = `http://127.0.0.1:${server.address().port}${new URL(zhipuBaseURL).pathname}`;
  try {
    await page.route(`${new URL(zhipuBaseURL).origin}/**`, route => route.abort());
    await page.route("**/api/model-configs/discover", async route => {
      const request = route.request();
      const body = request.postDataJSON();
      assert.equal(request.method(), "POST");
      assert.equal(body.url, zhipuBaseURL, "Use the selected preset's Base URL");
      assert.equal(body.kind, "agent");
      assert.equal(body.protocol, "openai");
      assert.ok(body.apiKey === zhipuFixtureKey, "Send the fixture API Key to the local backend");
      // Rewrite just the destination for the backend's real GET /models request.
      const response = await route.fetch({ postData: { ...body, url: fixtureURL } });
      await route.fulfill({ response });
    });
  } catch (error) {
    server.close();
    throw error;
  }
  return { requests, close: () => server.close() };
}
