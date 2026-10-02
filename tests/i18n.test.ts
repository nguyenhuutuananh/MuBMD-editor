import { describe, expect, test } from "bun:test";
import { SEVERITY, type ErrorCode, type IssueCode } from "../src/core";
import type { ClientErrorCode } from "../web/src/lib/backend";
import en from "../web/src/i18n/locales/en.json";
import vi from "../web/src/i18n/locales/vi.json";

type Tree = { [k: string]: string | Tree };

function flatten(tree: Tree, prefix = ""): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, v] of Object.entries(tree)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "string") out.set(key, v);
    else for (const [kk, vv] of flatten(v, key)) out.set(kk, vv);
  }
  return out;
}

const placeholders = (msg: string) => [...new Set([...msg.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!))].sort();

const EN = flatten(en as Tree);
const VI = flatten(vi as Tree);

describe("locale files", () => {
  test("en and vi have exactly the same keys", () => {
    const missingInVi = [...EN.keys()].filter((k) => !VI.has(k));
    const missingInEn = [...VI.keys()].filter((k) => !EN.has(k));
    expect({ missingInVi, missingInEn }).toEqual({ missingInVi: [], missingInEn: [] });
  });

  test("each key uses the same {…} placeholders in both languages", () => {
    const mismatch = [...EN].filter(([k, v]) => VI.has(k) && placeholders(v).join() !== placeholders(VI.get(k)!).join());
    expect(mismatch.map(([k]) => k)).toEqual([]);
  });

  test("no empty strings, no characters vue-i18n treats specially", () => {
    expect([...EN, ...VI].filter(([, v]) => !v.trim()).map(([k]) => k)).toEqual([]);
    // "@" starts a linked message, "<" is refused by the build, "|" only as the plural separator.
    expect([...EN, ...VI].filter(([, v]) => /[@<$]/.test(v)).map(([k]) => k)).toEqual([]);
  });

  test("every error code and issue code is translated", () => {
    // Listed by hand: adding a code to core/errors.ts without translating it fails this test (and tsc).
    const errorCodes: Record<ErrorCode | ClientErrorCode, true> = {
      "item-json": true, "item-name-invalid": true, "proposal-invalid": true, "zip-invalid": true, "package-invalid": true, "package-locale": true, "sheet-tab": true, "nothing-to-translate": true, "items-not-found": true, "resx-encoding": true, "resx-xml": true, "resx-root": true, "resx-invalid-char": true, "resx-not-editable": true,
      "resx-file-name": true, "locale-code": true, "no-folder": true, "no-resx": true, "no-default": true,
      "locale-not-found": true, "file-not-found": true, "not-a-folder": true, "file-locked": true,
      "permission-denied": true, "is-directory": true, "disk-full": true, "picker-unsupported": true,
      "picker-failed": true, "missing-path": true, "bad-json": true, "unsupported-media": true, "not-local": true,
      "unknown-api": true, internal: true, offline: true, "bad-response": true, "fs-unsupported": true,
      dirty: true, conflict: true, "save-verify-failed": true, "not-editable": true, "tsv-header": true, "import-changed": true,
    };
    for (const code of Object.keys(errorCodes)) expect([code, EN.has(`errors.${code}`)]).toEqual([code, true]);
    // SEVERITY lists every issue code; some have variants (see issueKey in web/src/i18n/index.ts).
    const variants: Partial<Record<IssueCode, string[]>> = {
      "stray-backslash": ["stray-backslash-newline", "stray-backslash-end", "stray-backslash-other"],
      "duplicate-key": ["duplicate-key", "duplicate-key-lost"],
    };
    for (const code of Object.keys(SEVERITY) as IssueCode[]) {
      for (const k of variants[code] ?? [code]) expect([k, EN.has(`issue.${k}`)]).toEqual([k, true]);
    }
    for (const s of ["error", "warning", "info"]) expect(EN.has(`severity.${s}`)).toBe(true);
  });
});
