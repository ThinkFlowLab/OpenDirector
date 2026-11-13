import { createElement } from "react";
import { createRoot } from "react-dom/client";
import type { ChatMessage } from "../../src/backend/chat";
import { AssistantReply } from "../../src/canvas/AssistantReply";
import { setActiveLocale, translate } from "../../src/i18n/messages";
import type { Translate } from "../../src/i18n/I18nProvider";
import type { Locale } from "../../src/i18n/types";
import "../../src/canvas/assistant-experience.css";

export function mountReply(element: HTMLElement) {
  setActiveLocale("en-US");
  const root = createRoot(element);
  return {
    render(message: ChatMessage, thinking = false, locale: Locale = "en-US") {
      setActiveLocale(locale);
      const t = ((key, params) => translate(locale, key, params)) as Translate;
      root.render(createElement(AssistantReply, { message, thinking, t }));
    },
    unmount() { root.unmount(); },
  };
}
