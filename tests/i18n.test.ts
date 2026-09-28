import { describe, expect, test } from "bun:test";
import type { ErrorCode, NameIssueCode } from "../src/core";
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

  test("no empty strings", () => {
    expect([...EN, ...VI].filter(([, v]) => !v.trim()).map(([k]) => k)).toEqual([]);
  });

  test("every error code and name-issue code is translated", () => {
    // Listed by hand: adding a code to core/errors.ts without translating it fails this test (and tsc).
    const errorCodes: Record<ErrorCode | "offline" | "bad-response", true> = {
      "bmd-size": true, "invalid-slot": true, "invalid-name": true, "name-bytes-length": true, "tsv-header": true, "import-changed": true,
      "no-file": true, dirty: true, conflict: true, "save-verify-failed": true,
      "file-not-found": true, "file-locked": true, "permission-denied": true, "is-directory": true,
      "not-a-file": true, "disk-full": true, "picker-unsupported": true, "picker-failed": true,
      "missing-path": true, "missing-name": true, "bad-json": true, "unsupported-media": true,
      "not-local": true, "unknown-api": true, internal: true, offline: true, "bad-response": true,
    };
    const issueCodes: Record<NameIssueCode, true> = {
      "too-long": true, "control-char": true, "lone-surrogate": true, "edge-whitespace": true, "double-space": true,
    };
    for (const code of Object.keys(errorCodes)) expect(EN.has(`errors.${code}`)).toBe(true);
    for (const code of Object.keys(issueCodes)) {
      expect(EN.has(`issues.${code}`)).toBe(true);
      expect(EN.has(`issueDetail.${code}`)).toBe(true);
    }
    for (let g = 0; g < 16; g++) expect(EN.has(`itemTypes.${g}`)).toBe(true);
  });
});
