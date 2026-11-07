import type { ReactNode, SVGProps } from "react";

export interface CanvasIconProps extends Omit<SVGProps<SVGSVGElement>, "name"> {
  name: string;
  size?: number;
}

/** One shape per content type, shared by creation tools, nodes and pickers. */
const icons: Record<string, ReactNode> = {
  text: <path d="M5 5h14M12 5v14M8 19h8M5 5v3M19 5v3" />,
  image: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="3" />
      <circle cx="8" cy="8" r="1.2" />
      <path d="m3 16 6-5 5 5 3-3 4 4" />
    </>
  ),
  video: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="3" />
      <path d="m10 8 6 4-6 4Z" />
    </>
  ),
  audio: <path d="M3 10v4M8 5v14M13 8v8M18 3v18M23 9v6" />,
  timeline: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="3" />
      <path d="M3 9h18M8 3v6M15 3v6" />
    </>
  ),
  clapperboard: (
    <g transform="rotate(-12 12 12)" fill="currentColor" stroke="none">
      <path d="M4 12h16v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Z" />
      <path
        transform="rotate(-22 4 11)"
        fillRule="evenodd"
        d="M5 7h14a1 1 0 0 1 1 1v3H4V8a1 1 0 0 1 1-1Zm3 0h2l-2 4H6Zm5 0h2l-2 4h-2Zm5 0h2l-2 4h-2Z"
      />
    </g>
  ),
  subject: (
    <>
      <rect x="3" y="2" width="18" height="20" rx="4" />
      <circle cx="12" cy="8" r="3" />
      <path d="M7 18v-1a5 5 0 0 1 10 0v1Z" />
    </>
  ),
  /** A round smiling face: the identification-driven face preset. */
  face: (
    <>
      <circle cx="12" cy="12" r="9.1" />
      <circle cx="9" cy="10" r="1.15" fill="currentColor" stroke="none" />
      <circle cx="15" cy="10" r="1.15" fill="currentColor" stroke="none" />
      <path d="M8.2 14.2c.9 1.7 2.2 2.5 3.8 2.5s2.9-.8 3.8-2.5" />
    </>
  ),
  /** A box seen from the corner: three faces, like a product three-view. */
  product: (
    <>
      <path d="M12 2.9 20.3 7.4 12 11.9 3.7 7.4Z" />
      <path d="M3.7 7.4v9.2L12 21.1l8.3-4.5V7.4" />
      <path d="M12 11.9v9.2" />
    </>
  ),
  canvas: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" strokeDasharray="3 3" />
      <rect x="6" y="6" width="7" height="5" rx="1" />
      <rect x="11" y="14" width="7" height="4" rx="1" />
    </>
  ),
  "rail-tool": (
    <>
      <circle cx="12" cy="12" r="10" />
      <circle cx="9" cy="7" r="1" />
      <circle cx="17" cy="10" r="1" />
      <circle cx="14" cy="17" r="1" />
      <circle cx="6" cy="14" r="1" />
      <circle cx="12" cy="12" r="1.3" />
    </>
  ),
  "rail-stage": (
    <>
      <path d="m12 2 5 3v6l-5 3-5-3V5Zm-5 3 5 3 5-3M12 8v6M5 12l-3 2v4l10 5 10-5v-4l-3-2M2 14l10 5 10-5M12 19v4" />
    </>
  ),
  "rail-folder": (
    <path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Zm0 3h18" />
  ),
  "rail-upload": <path d="M12 17V3m-6 6 6-6 6 6M4 17v4h16v-4" />,
  file: (
    <>
      <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z" />
      <path d="M14 3v6h6M8 13h8M8 17h5" />
    </>
  ),
  group: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="3" strokeDasharray="3 3" />
      <rect x="7" y="7" width="10" height="10" rx="2" />
    </>
  ),
  stack: (
    <>
      <rect x="3" y="7" width="15" height="14" rx="3" />
      <path d="M7 7V4h14v13h-3M7 17l3-4 5 4" />
    </>
  ),
  tool: (
    <>
      <path d="M14 4a5 5 0 0 0-6 6L3 16a3 3 0 0 0 5 5l6-7a5 5 0 0 0 6-6l-4 3-3-3Z" />
    </>
  ),
  external: (
    <>
      <path d="M3 5h18v15H3ZM3 9h18M5 5l3 4M11 5l3 4M17 5l3 4M9 13l6 3-6 3Z" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  cube: <path d="m12 3 9 5v8l-9 5-9-5V8Zm-9 5 9 5 9-5M12 13v8" />,
  collapse: <path d="m21 3-6 6m0-5v5h5M3 21l6-6m-5 0h5v5" />,
  thinking: (
    <path d="M9 18h6m-5 3h4M8 14a6 6 0 1 1 8 0c-1 1-1 2-1 3H9c0-1 0-2-1-3Z" />
  ),
  minus: <path d="M5 12h14" />,
  /** Rubber eraser: tilted block over the stroke it removes. */
  eraser: (
    <>
      <path d="m7 21-4.3-4.3a2.4 2.4 0 0 1 0-3.4l9.6-9.6a2.4 2.4 0 0 1 3.4 0l5.6 5.6a2.4 2.4 0 0 1 0 3.4L13 21" />
      <path d="M22 21H7M5 11l9 9" />
    </>
  ),
  close: <path d="m6 6 12 12M6 18 18 6" />,
  check: <path d="m5 12 4 4L19 6" />,
  pencil: (
    <>
      {/* Sharp graphite tip and a band near the blunt end; a flat cut at the
          nib read as an eyedropper at toolbar sizes. */}
      <path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" />
      <path d="m15 5 4 4" />
    </>
  ),
  edit: (
    <>
      <path d="m14 5 5 5M4 20l4-1 12-12a2.1 2.1 0 0 0-3-3L5 16Z" />
    </>
  ),
  more: (
    <>
      <circle cx="5" cy="12" r="1" />
      <circle cx="12" cy="12" r="1" />
      <circle cx="19" cy="12" r="1" />
    </>
  ),
  upload: (
    <>
      <path d="M12 16V3m-5 5 5-5 5 5M4 16v4h16v-4" />
    </>
  ),
  /** A framed canvas on its stand; the arrow leaves the frame. */
  canvasExport: (
    <>
      <path d="M4 5.2h16v11.4H4Z" />
      <path d="M2 16.6h20" />
      <path d="M6.4 16.6 5.8 20.4" />
      <path d="M17.6 16.6 18.2 20.4" />
      <path d="M8.2 5.2 8.63 2.5" />
      <path d="M15.8 5.2 15.37 2.5" />
      <path d="M12 15V8.6m-3 3 3-3 3 3" strokeWidth="2.05" />
    </>
  ),
  /** The same canvas with the arrow coming back into the frame. */
  canvasImport: (
    <>
      <path d="M4 5.2h16v11.4H4Z" />
      <path d="M2 16.6h20" />
      <path d="M6.4 16.6 5.8 20.4" />
      <path d="M17.6 16.6 18.2 20.4" />
      <path d="M8.2 5.2 8.63 2.5" />
      <path d="M15.8 5.2 15.37 2.5" />
      <path d="M12 7v6.4m-3-3 3 3 3-3" strokeWidth="2.05" />
    </>
  ),
  download: (
    <>
      <path d="M12 3v13m-5-5 5 5 5-5M4 16v4h16v-4" />
    </>
  ),
  arrowUp: <path d="M12 20V4m-6 6 6-6 6 6" />,
  arrowDown: <path d="M12 4v16m-6-6 6 6 6-6" />,
  arrowRight: <path d="M4 12h16m-6-6 6 6-6 6" />,
  arrowUpRight: <path d="M7 17 17 7M7 7h10v10" />,
  arrowLeft: <path d="M20 12H4m6-6-6 6 6 6" />,
  swapHorizontal: <path d="M5 8h14m-4-4 4 4-4 4M19 16H5m4-4-4 4 4 4" />,
  referenceArrowsHorizontal: <path d="M3 9h18l-5-4M21 15H3l5 4" />,
  referenceArrowsVertical: <path d="M9 21V3L5 8M15 3v18l4-5" />,
  chevronDown: <path d="m6 9 6 6 6-6" />,
  chevronRight: <path d="m9 6 6 6-6 6" />,
  camera: (
    <>
      <path d="M8 6 10 3h4l2 3h4a1 1 0 0 1 1 1v12H3V7a1 1 0 0 1 1-1Z" />
      <circle cx="12" cy="12" r="4" />
    </>
  ),
  palette: (
    <>
      <path d="M12 3a9 9 0 0 0 0 18h1a2 2 0 0 0 1-3.7 1.7 1.7 0 0 1 1-3.1H17a4 4 0 0 0 4-4A9 9 0 0 0 12 3Z" />
      <circle cx="7.5" cy="10" r=".7" />
      <circle cx="10" cy="6.5" r=".7" />
      <circle cx="15" cy="7" r=".7" />
    </>
  ),
  sparkle: (
    <>
      <path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5ZM20 2v4M18 4h4" />
    </>
  ),
  sliders: (
    <>
      <path d="M4 7h5m4 0h7M4 17h9m4 0h3" />
      <circle cx="11" cy="7" r="2" />
      <circle cx="15" cy="17" r="2" />
    </>
  ),
  stop: <rect x="6" y="6" width="12" height="12" rx="2" />,
  play: <path d="m7 4 14 8-14 8Z" />,
  pause: <path d="M8 5v14M16 5v14" />,
  link: (
    <>
      <path d="m9 15 6-6M8 17l-1 1a4.2 4.2 0 0 1-6-6l4-4a4.2 4.2 0 0 1 6 0m2 8a4.2 4.2 0 0 0 6 0l4-4a4.2 4.2 0 0 0-6-6l-1 1" />
    </>
  ),
  preview: (
    <>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  crop: (
    <>
      <path d="M6 2v16h16M2 6h16v16M10 6h8M6 10v8" />
    </>
  ),
  /** Marquee selection: a dashed frame, distinct from the crop handles. */
  marquee: (
    <>
      <rect
        x="3.5"
        y="3.5"
        width="17"
        height="17"
        rx="1.5"
        strokeDasharray="3.5 3"
      />
    </>
  ),
  /** Duration trim: two facing brackets with the playhead between them. */
  trim: (
    <>
      <path d="M10 7H8.4A1.4 1.4 0 0 0 7 8.4v7.2A1.4 1.4 0 0 0 8.4 17H10" />
      <path d="M14 7h1.6A1.4 1.4 0 0 1 17 8.4v7.2a1.4 1.4 0 0 1-1.4 1.4H14" />
      <path d="M12 4v16" />
    </>
  ),
  rotate: (
    <>
      <path d="M4 10a8 8 0 1 1 1 8M4 4v6h6" />
    </>
  ),
  flip: (
    <>
      <path d="M12 2v20M3 6l5 6-5 6ZM21 6l-5 6 5 6Z" />
    </>
  ),
  trash: (
    <>
      <path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7" />
    </>
  ),
  duplicate: (
    <>
      <rect x="8" y="8" width="12" height="12" rx="2" />
      <path d="M16 8V4H4v12h4" />
    </>
  ),
  lock: (
    <>
      <rect x="5" y="10" width="14" height="11" rx="3" />
      <path d="M8 10V6a4 4 0 0 1 8 0v4M12 14v3" />
    </>
  ),
  unlock: (
    <>
      <rect x="5" y="10" width="14" height="11" rx="3" />
      <path d="M8 10V6a4 4 0 0 1 7-2M12 14v3" />
    </>
  ),
  undo: (
    <>
      <path d="M4 4v6h6M4 10c4-6 16-5 16 3a7 7 0 0 1-7 7" />
    </>
  ),
  redo: (
    <>
      <path d="M20 4v6h-6M20 10C16 4 4 5 4 13a7 7 0 0 0 7 7" />
    </>
  ),
  hand: (
    <>
      <path d="M8 12V6a1.5 1.5 0 0 1 3 0v5-7a1.5 1.5 0 0 1 3 0v7-6a1.5 1.5 0 0 1 3 0v7-3a1.5 1.5 0 0 1 3 0v6a7 7 0 0 1-7 7h-1a7 7 0 0 1-5.5-2.7l-3.7-4.7a1.7 1.7 0 0 1 2.5-2.3L8 15" />
    </>
  ),
  cursor: (
    <path d="M5.5 3.5a1 1 0 0 0-1.4 1.2l4.5 16a1 1 0 0 0 1.9.1l2.6-7 7-2.6a1 1 0 0 0 .1-1.9Z" />
  ),
  minimap: <path d="m3 6 6-3 6 3 6-3v15l-6 3-6-3-6 3Zm6-3v15m6-12v15" />,
  connections: (
    <>
      <path d="m8.2 10.7 7.6-4.4m-7.6 7 7.6 4.4" />
      <circle cx="6" cy="12" r="2.5" />
      <circle cx="18" cy="5" r="2.5" />
      <circle cx="18" cy="19" r="2.5" />
    </>
  ),
  fit: <path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5M8 8h8v8H8Z" />,
  zoomIn: (
    <>
      <circle cx="10" cy="10" r="7" />
      <path d="m16 16 5 5M7 10h6M10 7v6" />
    </>
  ),
  zoomOut: (
    <>
      <circle cx="10" cy="10" r="7" />
      <path d="m16 16 5 5M7 10h6" />
    </>
  ),
  grid: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </>
  ),
  folder: <path d="M3 7V4h7l3 3h8v13H3Z" />,
  history: (
    <>
      <path d="M3 5v6h6M3 11a9 9 0 1 1 2 7M12 7v5l3 2" />
    </>
  ),
  layers: (
    <>
      <path d="m12 3 10 6-10 6L2 9ZM2 13l10 6 10-6M2 17l10 6 10-6" />
    </>
  ),
  fullscreen: <path d="M3 9V3h6m6 0h6v6M3 15v6h6m6 0h6v-6" />,
  exitFullscreen: <path d="M9 3v6H3m12-6v6h6M9 21v-6H3m12 6v-6h6" />,
  volume: (
    <>
      <path d="M11 4 6 8H2v8h4l5 4ZM15 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14" />
    </>
  ),
  volumeHigh: (
    <>
      <path d="M11 4 6 8H2v8h4l5 4ZM15 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14" />
    </>
  ),
  volumeOff: (
    <>
      <path d="M11 4 6 8H2v8h4l5 4Zm5 4 5 6m0-6-5 6" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  search: (
    <>
      <circle cx="10" cy="10" r="7" />
      <path d="m16 16 5 5" />
    </>
  ),
  help: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M9 9a3 3 0 0 1 6 0c0 2-3 2-3 4M12 17h.01" />
    </>
  ),
  star: (
    <path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3l-5.6 2.9 1.1-6.2L3 9.6l6.2-.9Z" />
  ),
  settings: (
    <>
      <path d="m10 3-.6 2.2-2 .9-2-.6-2 3.5L5 10.6v2.8l-1.6 1.6 2 3.5 2-.6 2 .9.6 2.2h4l.6-2.2 2-.9 2 .6 2-3.5-1.6-1.6v-2.8l1.6-1.6-2-3.5-2 .6-2-.9L14 3Z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  model: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="2" />
      <rect x="14" y="3" width="7" height="7" rx="2" />
      <rect x="3" y="14" width="7" height="7" rx="2" />
      <rect x="14" y="14" width="7" height="7" rx="2" />
    </>
  ),
};
const aliases: Record<string, string> = {
  pointer: "cursor",
  map: "fit",
  chevron: "chevronDown",
  arrow: "arrowUp",
  back: "arrowLeft",
  film: "video",
  expand: "fullscreen",
  copy: "duplicate",
};
/** Small authored icons shared by the canvas controls and node views. */
export function CanvasIcon({ name, size = 18, ...props }: CanvasIconProps) {
  const icon = aliases[name] ?? name;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      data-dropdown-chevron={icon === "chevronDown" ? "" : undefined}
      {...props}
    >
      {icons[icon] ?? icons.file}
    </svg>
  );
}

export default CanvasIcon;
