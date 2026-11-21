import type { Translate } from "../i18n/I18nProvider.tsx";

export function projectDisplayName(t: Translate, name: string, defaultNameIndex?: number | null) {
  if (defaultNameIndex == null) return name;
  return defaultNameIndex === 1
    ? t("canvas.project.defaultName")
    : t("canvas.project.defaultNameIndexed", { index: defaultNameIndex });
}
