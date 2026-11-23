import { messages } from "./messages.mjs";
import "./language.mjs";

const copy = messages[document.documentElement.lang];

const heroActions = document.querySelector(".hero .actions");
const installers = new Map([...heroActions.querySelectorAll("a[data-system]")].map(link => [link.dataset.system, link.href]));

const header = document.querySelector(".top");
const scrollActions = header.querySelector(".scroll-actions");
const headerActions = heroActions.cloneNode(true);
headerActions.removeAttribute("id");
scrollActions.appendChild(headerActions);
const downloadControls = [heroActions, headerActions].map((actions) => ({
  recommended: actions.querySelector("a.primary"),
  downloads: actions.querySelector("details"),
  summary: actions.querySelector("summary"),
  compact: actions === headerActions,
}));

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

function updateDownloadButtons(platform) {
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
  link.setAttribute("aria-label", shot.querySelector(".shot-caption span").textContent);
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
      outputClip.src = new URL("./film/office-preview.mp4", import.meta.url).href;
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
      button.textContent = copy.copied;
    } catch {
      const range = document.createRange();
      range.selectNodeContents(code);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      button.textContent = copy.copyManual;
    }
    reset = setTimeout(() => { button.textContent = copy.copy; }, 1800);
  });
}

const languageGroup = header.querySelector(".languages");
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

updateDownloadButtons({});
updateDownloadButtons(await detectPlatform());
