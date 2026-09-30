// locales.ts - Display names of the game's locales, in their own language: the same list as
// MuMain/tools/ResxGen/CppEmitter.cs. Unknown codes are shown as the code itself.

export const LOCALE_NAMES: Record<string, string> = {
  de: "Deutsch",
  en: "English",
  es: "Español",
  id: "Bahasa Indonesia",
  ja: "日本語",
  pl: "Polski",
  pt: "Português",
  ru: "Русский",
  tl: "Tagalog",
  uk: "Українська",
  vi: "Tiếng Việt",
  "zh-TW": "繁體中文",
};

export const localeName = (code: string): string => LOCALE_NAMES[code] ?? code;
