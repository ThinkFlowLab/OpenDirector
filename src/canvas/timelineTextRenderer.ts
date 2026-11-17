import { RULE_FACTS } from "../contracts/ruleFacts.generated.ts";
import { tNow } from "../i18n/messages.ts";
import { request } from "../backend/api.ts";
import type { TimelineData, TimelineTextOverlayView } from "./model.ts";
import { activeTimelineText } from "./timelineText.ts";
import {
  layoutTimelineText,
  type TimelineTextLayout,
} from "./timelineTextLayout.ts";

export interface TimelineFontSession {
  family(fontId: string): string;
  assertText(fontId: string, text: string): void;
  dispose(): void;
}
const maxFontBytes = RULE_FACTS.timelineFontBytes;
const coverageBytes = 0x110000 / 8;
// Cache immutable query facts by the digest of the actual bytes, never by a
// resource ID, caller-supplied coverage, or a mutable project snapshot.
const coverageCache = new Map<string, Promise<Uint8Array>>();

async function fontCoverage(bytes: ArrayBuffer, fingerprint: string) {
  let pending = coverageCache.get(fingerprint);
  if (!pending) {
    pending = request<{ fingerprint: string; coverage: string }>(
      "/creation/fonts/inspect",
      {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: bytes,
        // A consumer's cancellation must not cancel another consumer's query.
        signal: AbortSignal.timeout(30000),
      },
    ).then((value) => {
      if (
        value.fingerprint !== fingerprint ||
        typeof value.coverage !== "string" ||
        value.coverage.length !== 185688 ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(value.coverage)
      )
        throw new Error(tNow("errors.archive.integrity"));
      const decoded = atob(value.coverage);
      if (decoded.length !== coverageBytes)
        throw new Error(tNow("errors.archive.integrity"));
      return Uint8Array.from(decoded, (char) => char.charCodeAt(0));
    });
    if (coverageCache.size >= 16)
      coverageCache.delete(coverageCache.keys().next().value!);
    coverageCache.set(fingerprint, pending);
    void pending.catch(() => {
      if (coverageCache.get(fingerprint) === pending)
        coverageCache.delete(fingerprint);
    });
  }
  return pending;
}

async function readFont(
  response: Response,
  title: string,
): Promise<ArrayBuffer> {
  if (
    Number(response.headers.get("Content-Length")) > maxFontBytes ||
    !response.body
  ) {
    await response.body?.cancel();
    throw new Error(tNow("errors.render.fontLoad", { title }));
  }
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxFontBytes)
        throw new Error(tNow("errors.render.fontLoad", { title }));
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes.buffer;
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}
const layouts = new WeakMap<
  TimelineFontSession,
  Map<string, TimelineTextLayout>
>();

/** Font bytes come from validated project resources, never a system family fallback. */
export async function prepareTimelineFonts(
  timeline: TimelineData,
  signal: AbortSignal,
): Promise<TimelineFontSession> {
  signal.throwIfAborted();
  const families = new Map<string, string>(),
    coverage = new Map<string, Uint8Array>(),
    checked = new Map<string, Set<string>>(),
    owned: FontFace[] = [];
  let disposed = false;
  const session: TimelineFontSession = {
    family(fontId) {
      const family = families.get(fontId);
      if (disposed || !family)
        throw new Error(tNow("errors.render.fontMissing", { fontId }));
      return family;
    },
    assertText(fontId, text) {
      session.family(fontId);
      const seen = checked.get(fontId)!;
      if (seen.has(text)) return;
      const mask = coverage.get(fontId)!;
      // Identical exceptions to require_font_characters in media/fonts.py.
      for (const char of text) {
        if (char === "\n" || char === "\t") continue;
        const code = char.codePointAt(0)!;
        if (!(mask[code >> 3] & (1 << (code & 7))))
          throw new Error(tNow("errors.render.fontCoverage"));
      }
      if (seen.size >= 2000) seen.delete(seen.values().next().value!);
      seen.add(text);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const face of owned) document.fonts.delete(face);
      owned.length = 0;
      families.clear();
      coverage.clear();
      checked.clear();
      layouts.delete(session);
    },
  };
  try {
    const used = new Set(
      (timeline.overlays ?? []).map((overlay) => overlay.fontId),
    );
    const distinctFonts = new Set<string>();
    let totalBytes = 0;
    for (const fontId of used) {
      signal.throwIfAborted();
      const font = timeline.fonts?.find((item) => item.id === fontId);
      if (!font) throw new Error(tNow("errors.render.fontMissing", { fontId }));
      if (!font.src)
        throw new Error(tNow("errors.render.fontLoad", { title: font.title }));
      const response = await fetch(font.src, { signal });
      if (!response.ok)
        throw new Error(
          tNow("errors.render.readFailed", {
            title: font.title,
            status: response.status,
          }),
        );
      const bytes = await readFont(response, font.title);
      signal.throwIfAborted();
      // A deterministic family per immutable identity prevents same-title fonts colliding.
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      const hash = Array.from(new Uint8Array(digest), (b) =>
        b.toString(16).padStart(2, "0"),
      ).join("");
      const fingerprint = "sha256:" + hash;
      if (font.asset && font.asset.fingerprint !== fingerprint)
        throw new Error(tNow("errors.archive.integrity"));
      if (!distinctFonts.has(fingerprint)) {
        totalBytes += bytes.byteLength;
        if (totalBytes > RULE_FACTS.timelineFontTotalBytes)
          throw new Error(tNow("errors.render.fontBudget"));
        distinctFonts.add(fingerprint);
      }
      const mask = await fontCoverage(bytes, fingerprint);
      signal.throwIfAborted();
      const family = "OpenDirectorText_" + hash;
      const face = new FontFace(family, bytes);
      try {
        await face.load();
      } catch {
        signal.throwIfAborted();
        throw new Error(tNow("errors.render.fontLoad", { title: font.title }));
      }
      signal.throwIfAborted();
      document.fonts.add(face);
      owned.push(face);
      families.set(fontId, family);
      coverage.set(fontId, mask);
      checked.set(fontId, new Set());
    }
    signal.throwIfAborted();
    layouts.set(session, new Map());
    return session;
  } catch (error) {
    session.dispose();
    throw error;
  }
}

function cachedLayout(
  ctx: CanvasRenderingContext2D,
  overlay: TimelineTextOverlayView,
  timeline: TimelineData,
  fonts: TimelineFontSession,
): TimelineTextLayout {
  const cache = layouts.get(fonts);
  const key = JSON.stringify([
    fonts.family(overlay.fontId),
    overlay.text,
    overlay.x,
    overlay.y,
    overlay.maxWidth,
    overlay.style,
    timeline.width,
    timeline.height,
  ]);
  const existing = cache?.get(key);
  if (existing) return existing;
  const layout = layoutTimelineText(
    overlay,
    timeline,
    (text) => ctx.measureText(text).width,
  );
  // Keep editing bounded: a long-lived preview must not retain every historical draft.
  if (cache) {
    if (cache.size >= 2000) cache.delete(cache.keys().next().value!);
    cache.set(key, layout);
  }
  return layout;
}

/** The sole text drawing path for transparent preview canvases and encoded frames. */
export function drawTimelineText(
  ctx: CanvasRenderingContext2D,
  timeline: TimelineData,
  frame: number,
  fonts: TimelineFontSession,
): void {
  const active = activeTimelineText(timeline, frame);
  // Validate every active cue before layout or drawing any glyph/background.
  for (const overlay of active) fonts.assertText(overlay.fontId, overlay.text);
  ctx.save();
  try {
    ctx.beginPath();
    ctx.rect(0, 0, timeline.width, timeline.height);
    ctx.clip();
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    ctx.lineJoin = "round";
    for (const overlay of active) {
      ctx.font = `${overlay.style.fontSize}px "${fonts.family(overlay.fontId)}"`;
      const layout = cachedLayout(ctx, overlay, timeline, fonts);
      if (layout.background) {
        const background = layout.background;
        ctx.globalAlpha = background.opacity;
        ctx.fillStyle = background.color;
        ctx.fillRect(
          background.x,
          background.y,
          background.width,
          background.height,
        );
      }
      ctx.globalAlpha = 1;
      ctx.fillStyle = overlay.style.color;
      if (layout.stroke) {
        ctx.strokeStyle = layout.stroke.color;
        ctx.lineWidth = layout.stroke.width;
      }
      for (const line of layout.lines) {
        if (layout.stroke?.width)
          ctx.strokeText(line.text, line.x, line.baseline);
        ctx.fillText(line.text, line.x, line.baseline);
      }
    }
  } finally {
    ctx.restore();
  }
}
