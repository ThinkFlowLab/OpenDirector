/** Localize download and import failures for the example picker and first-run setup. */
import type { Translate } from "../../../i18n/I18nProvider.tsx";
import type { ExampleStatus } from "./useExampleImport.ts";

export function exampleFailureText(t: Translate, status: ExampleStatus): string {
  switch (status.code) {
    case "http":
      return t("canvas.example.error.http", { status: status.httpStatus ?? 0 });
    case "network":
      return t("canvas.example.error.network");
    case "html":
      return t("canvas.example.error.html");
    case "notArchive":
      return t("canvas.example.error.notArchive");
    case "ambiguous":
      return t("canvas.example.error.ambiguous");
    case "notCanvas":
      return t("canvas.example.error.notCanvas");
    case "tooLarge":
      return t("canvas.example.error.tooLarge");
    case "integrity":
      return t("canvas.example.error.integrity");
    case "invalidUrl":
      return t("canvas.example.error.invalidUrl");
    case "aborted":
      return t("canvas.example.error.aborted");
    default:
      // Archive validation fails with an already-localized message.
      return status.message || t("canvas.example.error.unknown");
  }
}

/** Completion percentage, or null while the server has not declared a size. */
export function examplePercent(status: ExampleStatus): number | null {
  if (!status.total || !status.received) return null;
  return Math.min(100, Math.round((status.received / status.total) * 100));
}
