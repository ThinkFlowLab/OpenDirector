import test from "node:test";
import assert from "node:assert/strict";
import { desktopExportStarted, type DesktopBridge } from "../src/desktop.ts";

test("overlapping exports keep desktop shutdown protection until the last export finishes", () => {
  const states: boolean[] = [];
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  const bridge: DesktopBridge = { registerSession: () => {}, setLocale: () => {}, setExporting: value => states.push(value) };
  Object.defineProperty(globalThis, "window", { configurable: true, value: { opendirectorDesktop: bridge } });
  try {
    const first = desktopExportStarted();
    const second = desktopExportStarted();
    first(); first(); second();
    assert.deepEqual(states, [true, true, true, false]);
  } finally {
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else Reflect.deleteProperty(globalThis, "window");
  }
});
