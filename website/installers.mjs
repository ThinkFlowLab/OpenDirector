const officialRepository = "ThinkFlowLab/OpenDirector";
const testRepository = "FayeSpica/OpenDirector";
const testTag = "v0.1.4-desktop-test.23";
const stableTag = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const versionOrder = new Intl.Collator("en", { numeric: true });
const packageSuffixes = {
  mac: "mac-arm64-adhoc.dmg",
  windows: "win-x64-unsigned.exe",
};

function releaseUrl(value, repository, kind) {
  const url = new URL(value);
  if (url.origin !== "https://github.com" || !url.pathname.startsWith(`/${repository}/releases/${kind}/`)) {
    throw new Error(`Unexpected GitHub ${kind} URL for ${repository}: ${url.href}`);
  }
  return url.href;
}

function addInstallers(installers, release, repository, test) {
  const version = release.tag_name.split("-")[0];
  for (const [system, suffix] of Object.entries(packageSuffixes)) {
    if (installers[system]) continue;
    const filename = `OpenDirector-${version}-${suffix}`;
    const asset = release.assets.find(item =>
      item.name === filename && item.state === "uploaded" && item.size > 0
    );
    if (asset) {
      installers[system] = {
        url: releaseUrl(asset.browser_download_url, repository, "download"),
        notes: releaseUrl(release.html_url, repository, "tag"),
        version: release.tag_name,
        test,
      };
    }
  }
}

export async function resolveInstallers(fetchImpl = fetch) {
  const headers = { Accept: "application/vnd.github+json" };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

  async function request(path) {
    const response = await fetchImpl(`https://api.github.com/repos/${path}`, {
      headers,
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`GitHub Releases request failed (${response.status}): ${path}`);
    return response;
  }

  const releases = [];
  for (let page = 1; ; page++) {
    const response = await request(`${officialRepository}/releases?per_page=100&page=${page}`);
    const entries = await response.json();
    releases.push(...entries.filter(release =>
      release.draft === false && release.prerelease === false && stableTag.test(release.tag_name)
    ));
    if (!response.headers.get("link")?.includes('rel="next"')) break;
  }
  releases.sort((a, b) => versionOrder.compare(b.tag_name, a.tag_name));

  const installers = {};
  for (const release of releases) {
    addInstallers(installers, release, officialRepository, false);
    if (installers.mac && installers.windows) return installers;
  }

  const response = await request(`${testRepository}/releases/tags/${testTag}`);
  const release = await response.json();
  if (release.tag_name === testTag && release.draft === false) {
    addInstallers(installers, release, testRepository, true);
  }
  return installers;
}
