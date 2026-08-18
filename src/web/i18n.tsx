import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";

export type Locale = "zh-CN" | "en";

const STORAGE_KEY = "remote-agent-locale";

type I18nValue = {
  locale: Locale;
  setLocale(locale: Locale): void;
  text(chinese: string, english: string): string;
  formatDate(value: string | null): string;
};

const I18nContext = createContext<I18nValue | null>(null);

const storedLocale = (): Locale => localStorage.getItem(STORAGE_KEY) === "en" ? "en" : "zh-CN";

export const I18nProvider = ({ children }: { children: ReactNode }) => {
  const [locale, setLocale] = useState<Locale>(storedLocale);
  const text = useCallback((chinese: string, english: string) => locale === "zh-CN" ? chinese : english, [locale]);
  const formatDate = useCallback((value: string | null): string => value === null ? "—" : new Intl.DateTimeFormat(locale, {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false
  }).format(new Date(value)), [locale]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, locale);
    document.documentElement.lang = locale;
  }, [locale]);

  const value = useMemo(() => ({ locale, setLocale, text, formatDate }), [formatDate, locale, text]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
};

export const useI18n = (): I18nValue => {
  const value = useContext(I18nContext);
  if (value === null) throw new Error("useI18n must be used inside I18nProvider");
  return value;
};
