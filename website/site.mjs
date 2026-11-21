const repository = "https://github.com/ThinkFlowLab/OpenDirector";
const localeKey = "opendirector.website.locale";
const messages = {
  "en-US": {
    shortDownload: "Download",
    shortInstall: "Install",
    projectCaption: "Project canvas · We Can Still Win",
    fullCanvas: "Open the full-size canvas image",
    filmLink: "Watch the short film",
    workflow: "We Can Still Win",
    filmIntro: "Six shots follow a Dota 2 player and his former teammates.",
    finalCut: "Final cut",
    shots: "Jump to a shot",
    otherInstall: "Other ways to install",
    aiBody: "Paste this prompt into your AI assistant.",
    sourceBody: "Clone the repository, then follow the guide for your operating system.",
    installPrompt: "Install and start OpenDirector for me by following this skill: https://github.com/ThinkFlowLab/OpenDirector/blob/main/.agents/skills/install-opendirector/SKILL.md",
    copy: "Copy",
    copied: "Copied",
    copyManual: "Select and copy",
    shot0: "At the café",
    shot1: "One more game",
    shot2: "Late at the office",
    shot3: "The group chat",
    shot4: "Bedtime",
    shot5: "Back at the desk",
    title: "Download OpenDirector",
    navigation: "Site",
    language: "Language",
    headline: "An open-source AI video studio",
    intro: "Generate shots with AI on the canvas, edit them on the timeline and export your film.",
    downloads: "Download OpenDirector",
    all: "All downloads",
    chooseMac: "Choose a macOS download",
    macDownload: "Download for macOS",
    windowsDownload: "Download for Windows",
    testBuild: "Test build",
    mac: "macOS (Apple silicon)",
    windows: "Windows (x64)",
    unavailable: "Installer unavailable",
    notes: "Release notes",
    macNotes: "macOS release notes",
    windowsNotes: "Windows release notes",
    source: "Source installation",
    guide: "Installation guide",
    aiInstall: "Install with AI",
    preview: "The script, six shots and timeline for We Can Still Win on the OpenDirector canvas",
  },
  "zh-CN": {
    shortDownload: "下载",
    shortInstall: "安装",
    projectCaption: "工程画布 · 我们还能赢",
    fullCanvas: "打开原尺寸画布截图",
    filmLink: "观看成片",
    workflow: "我们还能赢",
    filmIntro: "六个镜头讲述一个 Dota 2 玩家和老队友的故事。",
    finalCut: "导出成片",
    shots: "跳到镜头",
    otherInstall: "其他安装方式",
    aiBody: "复制这句话，发给你正在使用的 AI 助手。",
    sourceBody: "克隆仓库，再按照对应系统的安装指南完成配置。",
    installPrompt: "请按照这个 skill 帮我安装并启动 OpenDirector：https://github.com/ThinkFlowLab/OpenDirector/blob/main/.agents/skills/install-opendirector/SKILL.md",
    copy: "复制",
    copied: "已复制",
    copyManual: "请选中复制",
    shot0: "一起开黑",
    shot1: "再来一局",
    shot2: "加班的夜晚",
    shot3: "群里的消息",
    shot4: "哄孩子入睡",
    shot5: "回到电脑前",
    title: "下载 OpenDirector",
    navigation: "站点导航",
    language: "语言",
    headline: "开源 AI 影像工作台",
    intro: "和 AI 助手在画布上生成镜头，在时间线上剪辑，再导出影片。",
    downloads: "下载 OpenDirector",
    all: "所有下载",
    chooseMac: "选择 macOS 安装包",
    macDownload: "下载 macOS 版",
    windowsDownload: "下载 Windows 版",
    testBuild: "测试版",
    mac: "macOS（Apple 芯片）",
    windows: "Windows（x64）",
    unavailable: "暂无安装包",
    notes: "发布说明",
    macNotes: "macOS 发布说明",
    windowsNotes: "Windows 发布说明",
    source: "从源码安装",
    guide: "安装指南",
    aiInstall: "用 AI 安装",
    preview: "OpenDirector 画布上显示《我们还能赢》的剧本、六个分镜和时间线",
  },
};

const heroActions = document.querySelector(".hero .actions");
const installers = new Map([...heroActions.querySelectorAll("a[data-system]")].map(link => [link.dataset.system, link.href]));

const header = document.querySelector(".top");
const scrollActions = header.querySelector(".scroll-actions");
const headerActions = scrollActions.appendChild(heroActions.cloneNode(true));
const downloadControls = [heroActions, headerActions].map((actions) => ({
  recommended: actions.querySelector("a.primary"),
  downloads: actions.querySelector("details"),
  summary: actions.querySelector("summary"),
  compact: actions === headerActions,
}));
const languages = document.querySelectorAll("[data-lang]");

function readLocale() {
  try {
    const saved = localStorage.getItem(localeKey);
    if (Object.hasOwn(messages, saved)) return saved;
  } catch {}
  return /^zh(?:-|$)/i.test(navigator.language) ? "zh-CN" : "en-US";
}

async function detectPlatform() {
  const { userAgentData, userAgent } = navigator;
  if (userAgentData?.mobile || /Android|iPhone|iPad|iPod/i.test(userAgent)
    || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)) return {};
  const platform = userAgentData?.platform || navigator.platform;
  const system = /^mac/i.test(platform) ? "mac" : /^win/i.test(platform) ? "windows" : null;
  if (!system || !userAgentData?.getHighEntropyValues) return { system };

  try {
    const { architecture, bitness, wow64 } = await userAgentData.getHighEntropyValues([
      "architecture", "bitness", "wow64",
    ]);
    if (!architecture || !bitness) return { system };
    const compatible = system === "mac"
      ? architecture === "arm" && bitness === "64"
      : architecture === "x86" && (bitness === "64" || wow64 === true);
    return { system, compatible };
  } catch {
    return { system };
  }
}

let locale = readLocale();
let platform = {};

function render() {
  const copy = messages[locale];
  const chinese = locale === "zh-CN";
  document.documentElement.lang = locale;
  document.title = copy.title;
  for (const element of document.querySelectorAll("[data-text]")) {
    element.textContent = copy[element.dataset.text];
  }
  for (const element of document.querySelectorAll("[data-label]")) {
    element.setAttribute(element instanceof HTMLImageElement ? "alt" : "aria-label", copy[element.dataset.label]);
  }
  for (const button of languages) {
    button.setAttribute("aria-pressed", String(button.dataset.lang === locale));
  }
  for (const link of document.querySelectorAll("[data-install]")) {
    link.href = `${repository}/blob/main/docs/guides/installation${chinese ? ".zh-CN" : ""}.md`;
  }
  for (const link of document.querySelectorAll("[data-ai]")) {
    link.href = chinese
      ? `${repository}/blob/main/README.zh-CN.md#一句话安装`
      : `${repository}#install-with-ai`;
  }

  updateDownloadButtons();
}

function updateDownloadButtons() {
  const copy = messages[locale];
  const installer = platform.compatible && installers.get(platform.system);
  let menuLabel = copy.downloads;
  if (installer) menuLabel = copy.all;
  else if (platform.system === "mac" && platform.compatible === undefined && installers.has("mac")) menuLabel = copy.chooseMac;

  for (const { recommended, summary, compact } of downloadControls) {
    if (!installers.size) {
      recommended.href = "#install-heading";
      recommended.textContent = compact ? copy.shortInstall : copy.source;
      recommended.setAttribute("aria-label", copy.source);
      continue;
    }
    recommended.hidden = !installer;
    if (installer) {
      recommended.href = installer;
      const label = copy[`${platform.system}Download`];
      recommended.textContent = compact ? copy.shortDownload : label;
      recommended.setAttribute("aria-label", label);
    } else {
      recommended.removeAttribute("href");
    }
    summary.querySelector("span").textContent = compact && !installer ? copy.shortDownload : menuLabel;
    summary.setAttribute("aria-label", menuLabel);
  }
}

for (const button of languages) {
  button.addEventListener("click", () => {
    locale = button.dataset.lang;
    try { localStorage.setItem(localeKey, locale); } catch {}
    render();
  });
}
function closeOutsideDownloads(event) {
  for (const { downloads } of downloadControls) {
    if (downloads.open && !downloads.contains(event.target)) downloads.open = false;
  }
}
document.addEventListener("pointerdown", closeOutsideDownloads);
document.addEventListener("focusin", closeOutsideDownloads);
for (const { downloads, summary } of downloadControls) {
  downloads.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !downloads.open) return;
    downloads.open = false;
    summary.focus();
  });
}

const film = document.querySelector(".film-player video");
const shots = [...document.querySelectorAll(".film-shot")];
const stage = document.querySelector(".canvas-stage");
const canvasShots = document.querySelector(".canvas-shots");
const timeline = document.querySelector(".canvas-timeline");
const outputStill = document.querySelector(".canvas-output img");
const outputClip = document.querySelector(".canvas-output video");
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
let stageVisible = false;
let demoPhase = "idle";
let demoTimer;
let selectedShot = null;

function markTimeline(index) {
  timeline.style.setProperty("--shot-index", index);
  timeline.toggleAttribute("data-active", true);
}

function showFilmShot(index) {
  if (selectedShot === index) return;
  selectedShot = index;
  clearTimeout(demoTimer);
  outputClip.pause();
  outputClip.hidden = true;
  shots.forEach((shot, i) => {
    shot.setAttribute("aria-pressed", String(i === index));
    canvasShots.children[i].setAttribute("aria-current", String(i === index));
  });
  markTimeline(index);
  outputStill.src = shots[index].querySelector("img").src;
  outputStill.hidden = false;
}

for (const [index, shot] of shots.entries()) {
  const link = document.createElement("a");
  link.href = "#film";
  link.dataset.label = shot.querySelector("[data-text]").dataset.text;
  canvasShots.append(link);

  function playShot(event) {
    showFilmShot(index);
    film.currentTime = Number(shot.dataset.at);
    const trigger = event.currentTarget;
    film.play().catch((error) => {
      if (error.name !== "AbortError" && document.activeElement === trigger) film.focus();
    });
  }
  shot.addEventListener("click", playShot);
  link.addEventListener("click", playShot);
}

function syncFilmShot() {
  const index = shots.findLastIndex((shot) => Number(shot.dataset.at) <= film.currentTime);
  if (index >= 0) showFilmShot(index);
}
film.addEventListener("play", syncFilmShot);
film.addEventListener("seeking", syncFilmShot);
film.addEventListener("timeupdate", () => { if (selectedShot !== null) syncFilmShot(); });
// WebKit leaves a failed playback request in the playing state.
film.addEventListener("error", () => film.pause());

const officeShot = shots.findIndex((shot) => shot.dataset.at === "20");
function runCanvasDemo() {
  clearTimeout(demoTimer);
  if (selectedShot !== null || reducedMotion.matches || !stageVisible || document.hidden) {
    outputClip.pause();
    return;
  }
  if (demoPhase === "idle") {
    canvasShots.children[officeShot].setAttribute("aria-current", "true");
    demoPhase = "selected";
  }
  if (demoPhase === "selected") {
    demoTimer = setTimeout(() => {
      markTimeline(officeShot);
      demoPhase = "timeline";
      runCanvasDemo();
    }, 500);
  } else if (demoPhase === "timeline") {
    demoTimer = setTimeout(() => {
      outputClip.poster = shots[officeShot].querySelector("img").src;
      outputClip.src = "./film/office-preview.mp4";
      outputClip.hidden = false;
      demoPhase = "preview";
      runCanvasDemo();
    }, 480);
  } else if (demoPhase === "preview" && !outputClip.ended && outputClip.paused) {
    outputClip.play().catch((error) => {
      // An interrupted preview can resume. Other failures leave its poster on screen.
      if (error.name !== "AbortError") demoPhase = "poster";
    });
  }
}
new IntersectionObserver(([entry]) => {
  stageVisible = entry.intersectionRatio >= .55;
  runCanvasDemo();
}, { threshold: .55 }).observe(stage);
document.addEventListener("visibilitychange", runCanvasDemo);
reducedMotion.addEventListener("change", runCanvasDemo);

for (const button of document.querySelectorAll("[data-copy]")) {
  const code = button.parentElement.querySelector("code");
  let reset;
  button.addEventListener("click", async () => {
    clearTimeout(reset);
    try {
      await navigator.clipboard.writeText(code.textContent);
      button.textContent = messages[locale].copied;
    } catch {
      const range = document.createRange();
      range.selectNodeContents(code);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      button.textContent = messages[locale].copyManual;
    }
    reset = setTimeout(() => { button.textContent = messages[locale].copy; }, 1800);
  });
}

const languageGroup = header.querySelector(".languages");
languageGroup.hidden = false;
function updateHeader() {
  const compact = window.scrollY > 80;
  if (compact === header.classList.contains("is-scrolled")) return;
  header.classList.toggle("is-scrolled", compact);
  const outgoing = compact ? languageGroup : scrollActions;
  if (outgoing.contains(document.activeElement)) header.querySelector(".brand").focus({ preventScroll: true });
  languageGroup.inert = compact;
  scrollActions.inert = !compact;
  if (!compact) headerActions.querySelector("details").open = false;
}
window.addEventListener("scroll", updateHeader, { passive: true });
updateHeader();

render();
platform = await detectPlatform();
updateDownloadButtons();
