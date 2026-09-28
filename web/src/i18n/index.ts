// i18n - Tiếng Anh là mặc định và luôn hiện ở lần mở đầu tiên; tiếng Việt chọn trong menu, nhớ trong trình duyệt.

import { createI18n } from "vue-i18n";
import { isLang, type Lang, type NameIssue } from "../../../src/shared/api";
import { ApiError } from "@/lib/api";
import { KEYS, load, save } from "@/lib/storage";
import en from "./locales/en.json";
import vi from "./locales/vi.json";

export type MessageSchema = typeof en;

const long = {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
} as const;

const stored = load<unknown>(KEYS.lang, null);
const initial: Lang = isLang(stored) ? stored : "en";

export const i18n = createI18n<[MessageSchema], Lang, false>({
  legacy: false,
  locale: initial,
  fallbackLocale: "en",
  messages: { en, vi },
  datetimeFormats: { en: { long }, vi: { long } },
  missingWarn: false,
  fallbackWarn: false,
});

document.documentElement.lang = initial;

export function currentLang(): Lang {
  return i18n.global.locale.value as Lang;
}

export function setLang(lang: Lang): void {
  i18n.global.locale.value = lang;
  document.documentElement.lang = lang;
  save(KEYS.lang, lang);
}

// Dịch có số nhiều: tham số `count` hoặc `n` quyết định dạng số ít/nhiều (tiếng Anh).
export function tr(key: string, params: Record<string, unknown> = {}): string {
  const t = i18n.global.t as (k: string, named: Record<string, unknown>, plural?: number) => string;
  const n = typeof params.count === "number" ? params.count : typeof params.n === "number" ? params.n : undefined;
  return n === undefined ? t(key, params) : t(key, params, n);
}

export function fmtTime(iso: string): string {
  return iso ? i18n.global.d(new Date(iso), "long") : "";
}

export function fmtNumber(n: number): string {
  return new Intl.NumberFormat(currentLang() === "vi" ? "vi-VN" : "en-US").format(n);
}

export function issueText(issue: Pick<NameIssue, "code" | "params">): string {
  return tr(`issueDetail.${issue.code}`, issue.params ?? {});
}

// Lỗi từ server/giao diện -> câu theo ngôn ngữ đang chọn.
export function errorText(e: unknown): string {
  if (e instanceof ApiError) {
    const firstIssue = e.issues?.find((i) => i.severity === "error");
    if (e.code === "invalid-name" && firstIssue) return issueText(firstIssue);
    const key = `errors.${e.code}`;
    if (i18n.global.te(key, "en")) return tr(key, e.params);
    return e.message;
  }
  return e instanceof Error ? e.message : String(e);
}
