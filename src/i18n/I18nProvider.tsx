import "../desktop.ts";
/** React binding for the locale catalog. */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  applyDocumentLocale,
  detectLocale,
  isLocale,
  LOCALE_KEY,
  writeLocale,
} from "./locale.ts";
import {
  setActiveLocale,
  translate,
  translateDescriptor,
} from "./messages.ts";
import { setRequestLocale } from "../backend/api.ts";
import type {
  Locale,
  MessageDescriptor,
  MessageKey,
  MessageParams,
} from "./types.ts";

export type Translate = {
  (key: MessageKey, params?: MessageParams): string;
  (message: MessageDescriptor): string;
};

type I18nValue = {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: Translate;
};

const I18nContext = createContext<I18nValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(() => {
    const detected = detectLocale();
    // Non-React helpers call tNow during the first render. Resolve the active
    // locale before children render, not after the effect below.
    setActiveLocale(detected);
    setRequestLocale(detected);
    return detected;
  });

  useEffect(() => {
    setActiveLocale(locale);
    setRequestLocale(locale);
    applyDocumentLocale(locale);
  }, [locale]);

  useEffect(() => {
    window.opendirectorDesktop?.setLocale(locale);
    document.title = translate(locale, "app.title");
    const description = document.querySelector<HTMLMetaElement>(
      'meta[name="description"]',
    );
    if (description) {
      description.content = translate(locale, "app.description");
    }
  }, [locale]);

  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key === LOCALE_KEY && isLocale(event.newValue)) {
        setActiveLocale(event.newValue);
        setRequestLocale(event.newValue);
        setLocaleState(event.newValue);
      }
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);

  const setLocale = useCallback((next: Locale) => {
    // Children may call tNow while rendering, so publish the active locale
    // before the state update rather than waiting for the effect.
    setActiveLocale(next);
    setRequestLocale(next);
    // Persist only an explicit choice; a detected browser language must keep
    // following the browser on the next visit.
    writeLocale(next);
    setLocaleState((current) => (current === next ? current : next));
  }, []);

  const t = useCallback(
    ((input: MessageKey | MessageDescriptor, params?: MessageParams) =>
      typeof input === "string"
        ? translate(locale, input, params)
        : translateDescriptor(locale, input)) as Translate,
    [locale],
  );

  const value = useMemo(
    () => ({ locale, setLocale, t }),
    [locale, setLocale, t],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const value = useContext(I18nContext);
  if (!value) {
    throw new Error("useI18n must be used inside I18nProvider");
  }
  return value;
}

export function useT(): Translate {
  return useI18n().t;
}
