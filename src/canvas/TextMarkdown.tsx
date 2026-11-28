import { memo, useMemo } from "react";
import { Streamdown, type LinkSafetyModalProps } from "streamdown";
import { useT } from "../i18n/I18nProvider";
import { AssistantLinkInfo } from "./AssistantLinkInfo";
import "./text-markdown.css";

export const TextMarkdown = memo(function TextMarkdown({
  text,
}: {
  text: string;
}) {
  const t = useT();
  const linkSafety = useMemo(
    () => ({
      enabled: true,
      renderModal: (props: LinkSafetyModalProps) =>
        props.isOpen ? <AssistantLinkInfo {...props} t={t} /> : null,
    }),
    [t],
  );
  return (
    <Streamdown
      className="cw-text-markdown"
      controls={false}
      mode="static"
      isAnimating={false}
      linkSafety={linkSafety}
    >
      {text}
    </Streamdown>
  );
});
