import type { SVGProps } from "react";

import { TOOL_GLYPHS, type ToolGlyphName } from "./toolGlyphs";

export interface ToolIconProps extends Omit<
  SVGProps<SVGSVGElement>,
  "name" | "size"
> {
  name: ToolGlyphName;
  size?: number;
}

/** Filled tool glyphs for the selection toolbar, drawn on the same 24 grid as
 * CanvasIcon but as solid shapes so tool buttons outweigh ordinary chrome. */
export function ToolIcon({ name, size = 20, ...props }: ToolIconProps) {
  const glyph = TOOL_GLYPHS[name] ?? TOOL_GLYPHS["smart-edit"];
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      {...props}
    >
      {glyph.d.map((d, index) => (
        <path key={index} d={d} fillRule="evenodd" />
      ))}
    </svg>
  );
}

export default ToolIcon;
