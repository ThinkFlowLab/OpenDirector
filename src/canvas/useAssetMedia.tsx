import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ComponentProps,
  type ElementType,
} from "react";
import { parseAssetSource } from "../backend/assetSource.ts";
import { creationClient, MEDIA_PRIORITY } from "../backend/creationClient.ts";

export type AssetMediaState = "loading" | "ready" | "failed";

/** False for media inside a canvas node that is away from the viewport. */
export const AssetMediaActive = createContext(true);

const viewportCallbacks = new WeakMap<Element, (visible: boolean) => void>();
let viewportObserver: IntersectionObserver | undefined;

function observeViewport(element: Element, callback: (visible: boolean) => void) {
  // One observer serves every canvas node, including nearby off-screen nodes.
  viewportObserver ??= new IntersectionObserver(
    (entries) => {
      for (const entry of entries)
        viewportCallbacks.get(entry.target)?.(entry.isIntersecting);
    },
    { rootMargin: "160px" },
  );
  viewportCallbacks.set(element, callback);
  viewportObserver.observe(element);
  return () => {
    viewportObserver?.unobserve(element);
    viewportCallbacks.delete(element);
  };
}

export function useInViewport<T extends Element>() {
  const [element, setElement] = useState<T | null>(null);
  const [visible, setVisible] = useState(
    typeof IntersectionObserver === "undefined",
  );
  useEffect(
    () => (element ? observeViewport(element, setVisible) : undefined),
    [element],
  );
  return [setElement, visible] as const;
}

/** Resolves a media field for display. Inline and object URLs pass through.
 * Leaving the viewport cancels a read nothing else is waiting for. */
export function useAssetMedia(
  source: string | null | undefined,
  active?: boolean,
): { src?: string; state: AssetMediaState; retry: () => void } {
  const inherited = useContext(AssetMediaActive);
  const enabled = active ?? inherited;
  const asset = parseAssetSource(source);
  const [loaded, setLoaded] = useState<{
    source: string;
    src?: string;
  }>();
  const [attempt, setAttempt] = useState(0);
  const projectId = asset?.projectId;
  const assetId = asset?.assetId;
  useEffect(() => {
    if (!projectId || !assetId || !enabled) return;
    const controller = new AbortController();
    creationClient(projectId)
      .mediaUrl(assetId, {
        signal: controller.signal,
        priority: MEDIA_PRIORITY.visible,
      })
      .then((src) => {
        if (!controller.signal.aborted) setLoaded({ source: source!, src });
      })
      .catch(() => {
        if (!controller.signal.aborted) setLoaded({ source: source! });
      });
    return () => controller.abort();
  }, [source, projectId, assetId, enabled, attempt]);
  const retry = useCallback(() => {
    setLoaded(undefined);
    setAttempt((value) => value + 1);
  }, []);
  if (!asset)
    return { src: source ?? undefined, state: "ready", retry };
  if (!loaded || loaded.source !== source) return { state: "loading", retry };
  return loaded.src
    ? { src: loaded.src, state: "ready", retry }
    : { state: "failed", retry };
}

type MediaTag = "img" | "video" | "audio";

/** A media element whose source may be a saved asset. A failed read keeps the
 * unresolvable value so the element's own error handling still runs. */
export function AssetMedia<Tag extends MediaTag>({
  as,
  src,
  ...props
}: { as: Tag; src?: string } & Omit<ComponentProps<Tag>, "src">) {
  const media = useAssetMedia(src);
  const Element = as as ElementType;
  return <Element {...props} src={media.state === "failed" ? src : media.src} />;
}
