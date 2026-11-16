import type { AgentRuntime } from "./chat.ts";
import type { Locale } from "../i18n/types.ts";
import { json, request } from "./api.ts";

export interface PluginManifest {
  schemaVersion: 1;
  id: string;
  version: string;
  name: Record<Locale, string>;
  description: Record<Locale, string>;
  runtimes: AgentRuntime[];
  dependencies: Record<string, string>;
}
export interface InstalledPlugin {
  manifest: PluginManifest;
  digest: string;
  source: string;
  enabledRuntimes: AgentRuntime[];
}
export interface PluginCatalog {
  installed: InstalledPlugin[];
  examples: { manifest: PluginManifest; source: string }[];
  runtimes: AgentRuntime[];
}

export const PLUGINS_CHANGED = "opendirector:plugins-changed";
export const pluginCatalog = (signal?: AbortSignal) => request<PluginCatalog>("/plugins", { signal });
export const installPlugin = (source: string | File) =>
  request<InstalledPlugin>("/plugins" + (typeof source === "string" ? "" : "/upload"),
    typeof source === "string" ? json("POST", { source }) : {
      method: "POST", headers: { "Content-Type": "application/zip" }, body: source,
    });
export const enablePlugin = (plugin: InstalledPlugin, runtime: AgentRuntime, enabled: boolean) =>
  request<PluginCatalog>(`/plugins/${plugin.manifest.id}/runtimes/${runtime}`,
    json("PUT", { digest: plugin.digest, enabled }));
export const removePlugin = (plugin: InstalledPlugin) =>
  request<PluginCatalog>(`/plugins/${plugin.manifest.id}`, json("DELETE", { digest: plugin.digest }));
