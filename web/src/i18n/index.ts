// i18n - English is the default and always shown on first launch; Vietnamese is picked from the menu and remembered.

import { createI18n } from "vue-i18n";
import type { GlossaryHint } from "../../../src/core/glossary";
import { isLang, type Lang, type RowIssue } from "../../../src/shared/api";
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

// Translate with plurals: a `count` or `n` param selects the singular/plural form (English).
export function tr(key: string, params: Record<string, unknown> = {}): string {
  const t = i18n.global.t as (k: string, named: Record<string, unknown>, plural?: number) => string;
  const n = typeof params.count === "number" ? params.count : typeof params.n === "number" ? params.n : undefined;
  return n === undefined ? t(key, params) : t(key, params, n);
}

export function fmtTime(iso: string): string {
  return iso ? i18n.global.d(new Date(iso), "long") : "";
}

// Validator issue -> sentence. A few codes have variants chosen by their params.
export function issueKey([code, , params = {}]: RowIssue): string {
  if (code === "stray-backslash") {
    const next = params.next;
    return next === "newline" ? "issue.stray-backslash-newline" : next === "end" ? "issue.stray-backslash-end" : "issue.stray-backslash-other";
  }
  if (code === "duplicate-key" && params.lostLegacyIds) return "issue.duplicate-key-lost";
  return `issue.${code}`;
}

export function issueText(issue: RowIssue): string {
  return tr(issueKey(issue), issue[2] ?? {});
}

export function glossaryHintText(h: GlossaryHint): string {
  if (h.kind === "ok") return h.translation ? tr("glossaryHint.ok", { term: h.term, translation: h.translation }) : tr("glossaryHint.okKeep", { term: h.term });
  return tr(`glossaryHint.${h.kind}`, { term: h.term, translation: h.translation ?? "" });
}

// Server / client error -> sentence in the current language.
export function errorText(e: unknown): string {
  if (e instanceof ApiError) {
    const key = `errors.${e.code}`;
    if (i18n.global.te(key, "en")) return tr(key, e.params);
    return e.message;
  }
  return e instanceof Error ? e.message : String(e);
}
