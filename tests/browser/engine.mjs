/** Launch the isolated browser for the support matrix.
 *
 * BROWSER=chromium|firefox|webkit selects the engine (default chromium).
 * BROWSER_PATH (or the legacy CHROMIUM_PATH) points at an existing binary.
 * Container flags are only passed to Chromium; other engines reject them.
 */
export async function launchBrowser() {
  const playwright = await import(
    process.env.PLAYWRIGHT_MODULE ?? "playwright-core"
  );
  const name = process.env.BROWSER ?? "chromium";
  const engine = playwright[name];
  if (!engine) throw new Error(`unknown BROWSER=${name}`);
  const executablePath = process.env.BROWSER_PATH ?? process.env.CHROMIUM_PATH;
  return engine.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
    ...(name === "chromium"
      ? { args: ["--no-sandbox", "--disable-dev-shm-usage"] }
      : {}),
  });
}
