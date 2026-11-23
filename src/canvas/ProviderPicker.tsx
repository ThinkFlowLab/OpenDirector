import type { ModelConfig, ModelKind } from "../backend/rules";
import { SearchableSelect } from "./SearchableSelect";
import { providerOptions } from "./providerPresets";
import { useT } from "../i18n/I18nProvider.tsx";

export function ProviderPicker({
  kind,
  allowProtocol,
  ...props
}: {
  kind: ModelKind;
  allowProtocol?: (protocol: ModelConfig["protocol"]) => boolean;
  value: string;
  disabled: boolean;
  onChange: (id: string) => void;
}) {
  const t = useT();
  return (
    <SearchableSelect
      {...props}
      label={t("models.service.provider")}
      options={providerOptions(kind, allowProtocol)}
    />
  );
}
