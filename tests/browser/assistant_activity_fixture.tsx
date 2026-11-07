import { createElement } from "react";
import { createRoot } from "react-dom/client";
import type { ChatMessage } from "../../src/backend/chat";
import { AssistantReply } from "../../src/canvas/AssistantReply";
import { setActiveLocale } from "../../src/i18n/messages";
import "../../src/canvas/assistant-experience.css";

export function mountReply(element: HTMLElement) {
  setActiveLocale("en-US");
  const root = createRoot(element);
  return {
    render(message: ChatMessage, thinking = false) {
      root.render(createElement(AssistantReply, { message, thinking }));
    },
    unmount() { root.unmount(); },
  };
}
