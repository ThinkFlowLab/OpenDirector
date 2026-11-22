/** Desktop lifecycle signals; business commands stay on the shared API. */
export interface DesktopBridge {
  registerSession(id: string): void;
  setLocale(locale: "zh-CN" | "en-US"): void;
  showMore?(): void;
  setExporting(active: boolean): void;
}

declare global {
  interface Window { opendirectorDesktop?: DesktopBridge }
}

let exportsInProgress = 0;
export function desktopExportStarted(): () => void {
  exportsInProgress += 1;
  globalThis.window?.opendirectorDesktop?.setExporting(true);
  let finished = false;
  return () => {
    if (finished) return;
    finished = true;
    exportsInProgress -= 1;
    globalThis.window?.opendirectorDesktop?.setExporting(exportsInProgress > 0);
  };
}
