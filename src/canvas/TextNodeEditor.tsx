import { useLayoutEffect, useRef, type TextareaHTMLAttributes } from "react";

export interface TextSelection {
  start: number;
  end: number;
  direction: "forward" | "backward" | "none";
  scrollTop: number;
}
export type TextSelections = Map<string, TextSelection>;

export function TextNodeEditor({
  id,
  locked,
  selections,
  onUpdate,
  ...props
}: {
  id: string;
  locked: boolean;
  selections: TextSelections;
  onUpdate: (text: string) => void;
} & Omit<
  TextareaHTMLAttributes<HTMLTextAreaElement>,
  "id" | "onChange"
>) {
  const input = useRef<HTMLTextAreaElement>(null);
  const remember = (area: HTMLTextAreaElement) =>
    selections.set(id, {
      start: area.selectionStart,
      end: area.selectionEnd,
      direction: area.selectionDirection,
      scrollTop: area.scrollTop,
    });
  useLayoutEffect(() => {
    const area = input.current!;
    const saved = selections.get(id);
    area.focus({ preventScroll: true });
    if (saved) {
      area.setSelectionRange(saved.start, saved.end, saved.direction);
      area.scrollTop = saved.scrollTop;
    }
    return () => {
      remember(area);
    };
  }, [id, selections]);
  return (
    <textarea
      {...props}
      ref={input}
      readOnly={locked}
      spellCheck={false}
      onSelect={(event) => remember(event.currentTarget)}
      onScroll={(event) => remember(event.currentTarget)}
      onChange={(event) => {
        remember(event.currentTarget);
        if (!locked) onUpdate(event.currentTarget.value);
      }}
    />
  );
}
