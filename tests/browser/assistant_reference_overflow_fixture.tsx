import { createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { ChatAsset } from "../../src/backend/chat";
import { assetDisplayName } from "../../src/canvas/assetNames.ts";
import { ChatReferenceChip } from "../../src/canvas/ChatReferenceChip";
import { setActiveLocale, translate } from "../../src/i18n/messages";
import type { Locale } from "../../src/i18n/types";
import "../../src/canvas/assistant-panel.css";
import "../../src/canvas/assistant-experience.css";
import "../../src/canvas/reference-mentions.css";

const LONG_ZH =
  "角色三视图设定稿：在同一张画面中并排绘制同一人物的正面、侧面（90度侧脸）和背面三个视角，三个人物高度尽量一致、脚部处于同一水平线，穿着与发型在三视图中完全一致.png";
const LONG_EN =
  "Character three-view turnaround sheet: front, 90-degree side and back of the same person on one page, aligned feet and identical costume.png";
const SHORT_ZH = "导演台 1 · 动作预演";

const imageAsset = (id: string, name: string): ChatAsset => ({
  id,
  name,
  type: "image/png",
  size: 1024,
  fingerprint: `fp-${id}`,
});

const videoAsset = (id: string, name: string): ChatAsset => ({
  id,
  name,
  type: "video/mp4",
  size: 2048,
  fingerprint: `fp-${id}`,
});

function bubble(key: string, children: ReactNode, toggleLabel: string) {
  return createElement(
    "article",
    { key, className: "cw-assistant-message is-user", "data-case": key },
    createElement("div", { className: "cw-assistant-message-text" }, children),
    createElement(
      "div",
      { className: "cw-chat-attachments" },
      createElement(
        "button",
        {
          type: "button",
          className: "cw-chat-attachments-toggle",
          "aria-expanded": "true",
        },
        toggleLabel,
      ),
    ),
  );
}

function composerChip(name: string) {
  return createElement(
    "span",
    { className: "cw-chat-reference", "data-composer-chip": name },
    createElement("span", {
      "data-reference-icon": "1",
      "aria-hidden": "true",
    }),
    createElement(
      "span",
      { className: "cw-chat-reference-label" },
      assetDisplayName(name),
    ),
  );
}

export function mountReferenceOverflow(element: HTMLElement) {
  const root = createRoot(element);
  return {
    render(
      locale: Locale = "zh-CN",
      panelWidth = 420,
      theme: "dark" | "light" = "dark",
    ) {
      setActiveLocale(locale);
      document.documentElement.dataset.theme = theme;
      const chipLabel = (name: string) =>
        translate(locale, "assistant.reference.chip", {
          name: assetDisplayName(name),
        });
      const toggle = translate(locale, "assistant.media.collapse");
      const longImage = imageAsset("long-image", LONG_ZH);
      const shortVideo = videoAsset("short-video", SHORT_ZH);
      const longEnglish = imageAsset("long-en", LONG_EN);
      root.render(
        createElement(
          "aside",
          {
            className: "cw-assistant-panel",
            style: {
              position: "relative",
              width: panelWidth,
              height: "auto",
              inset: "auto",
            },
          },
          bubble(
            "long-zh",
            [
              "参考视频",
              createElement(ChatReferenceChip, {
                key: "short",
                name: shortVideo.name,
                assetId: shortVideo.id,
                asset: shortVideo,
                ariaLabel: chipLabel(shortVideo.name),
              }),
              "替换成",
              createElement(ChatReferenceChip, {
                key: "long",
                name: longImage.name,
                assetId: longImage.id,
                asset: longImage,
                ariaLabel: chipLabel(longImage.name),
              }),
              "，场景为 nvdia 大楼",
            ],
            toggle,
          ),
          bubble(
            "long-en",
            [
              "Replace ",
              createElement(ChatReferenceChip, {
                key: "en",
                name: longEnglish.name,
                assetId: longEnglish.id,
                asset: longEnglish,
                ariaLabel: chipLabel(longEnglish.name),
              }),
              " in this shot.",
            ],
            toggle,
          ),
          bubble(
            "short-only",
            [
              "只用",
              createElement(ChatReferenceChip, {
                key: "short-only",
                name: shortVideo.name,
                assetId: shortVideo.id,
                asset: shortVideo,
                ariaLabel: chipLabel(shortVideo.name),
              }),
              "即可",
            ],
            toggle,
          ),
          bubble(
            "icon-only",
            [
              "图标",
              createElement(ChatReferenceChip, {
                key: "icon",
                name: "",
                assetId: "icon-only",
                asset: imageAsset("icon-only", ""),
                ariaLabel: chipLabel(""),
              }),
              "引用",
            ],
            toggle,
          ),
          createElement(
            "div",
            {
              className: "cw-chat-reference-editor",
              "data-composer": "true",
              contentEditable: true,
              suppressContentEditableWarning: true,
            },
            "草稿",
            composerChip(LONG_ZH),
            "继续",
          ),
        ),
      );
    },
    unmount() {
      root.unmount();
    },
  };
}
