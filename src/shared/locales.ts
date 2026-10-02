// locales.ts - Display names of the game's locales, in their own language: the same list as
// MuMain/tools/ResxGen/CppEmitter.cs. A workspace can name a locale itself
// (.mumain-translator/locales.json, see src/session/localeNames.ts): a new one ("th" -> "ภาษาไทย"),
// or another name for a known one.

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

// MuMain's name of a locale; unknown codes are shown as the code itself.
export const localeName = (code: string): string => LOCALE_NAMES[code] ?? code;

// The name to show: the workspace's own name for it, else MuMain's.
export const localeLabel = (code: string, names?: Record<string, string> | null): string => names?.[code] || localeName(code);

// A name to start from for a new locale: MuMain's, else the language's name in that language as the
// browser / OS knows it ("th" -> "ไทย", "ko" -> "한국어"), else "".
export function suggestLocaleName(code: string): string {
  if (LOCALE_NAMES[code]) return LOCALE_NAMES[code]!;
  try {
    const name = new Intl.DisplayNames([code], { type: "language" }).of(code);
    if (name && name.toLowerCase() !== code.toLowerCase()) return name.charAt(0).toLocaleUpperCase(code) + name.slice(1);
  } catch {
    // not a code Intl knows
  }
  return "";
}
