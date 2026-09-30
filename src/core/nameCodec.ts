// nameCodec.ts - Validate translated item names.
//
// The game copies a name into the MAX_ITEM_NAME (50) wide-character ITEM_ATTRIBUTE::Name, so at most
// 49 characters are shown; MuMain counts them as wchar_t, i.e. UTF-16 code units on Windows. An
// over-long name is an error here (MuMain only warns and cuts it), so the translator shortens it.

import { AppError } from "./errors";

export const MAX_NAME_CHARS = 49;

// MuMain's LocalizedString separator ("English||pt=..."): a name must not contain it.
export const NAME_SEPARATOR = "||";

export type NameIssueCode = "too-long" | "control-char" | "lone-surrogate" | "separator" | "edge-whitespace" | "double-space";

// The English `message` is only for logs; the UI translates `code` + `params`.
export interface NameIssue {
  code: NameIssueCode;
  severity: "error" | "warning";
  message: string;
  params?: Record<string, number>;
}

export interface NameCheck {
  normalized: string; // NFC form - the form written to the file
  length: number; // characters as the game counts them (UTF-16 code units)
  issues: NameIssue[];
  ok: boolean; // no "error"-level issue
}

// Length as the game counts it (see above), of the NFC form.
export const nameLength = (name: string) => name.normalize("NFC").length;

// Vietnamese typed in decomposed form (NFD, e.g. on macOS) is longer and may render wrongly in the
// game font, so names are always normalized to NFC.
export function checkName(name: string): NameCheck {
  const normalized = name.normalize("NFC");
  const length = normalized.length;
  const issues: NameIssue[] = [];

  if (length > MAX_NAME_CHARS) {
    issues.push({
      code: "too-long",
      severity: "error",
      message: `Name is ${length} characters, over the ${MAX_NAME_CHARS}-character limit.`,
      params: { chars: length, max: MAX_NAME_CHARS },
    });
  }
  if (/[\u0000-\u001f\u007f]/.test(normalized)) {
    issues.push({ code: "control-char", severity: "error", message: "Name contains control characters (tab, newline, 0x00...)." });
  }
  if (/\p{Cs}/u.test(normalized)) {
    issues.push({ code: "lone-surrogate", severity: "error", message: "Name contains broken Unicode (lone surrogate)." });
  }
  if (normalized.includes(NAME_SEPARATOR)) {
    issues.push({ code: "separator", severity: "error", message: `Name must not contain "${NAME_SEPARATOR}".` });
  }
  if (normalized !== normalized.trim()) {
    issues.push({ code: "edge-whitespace", severity: "warning", message: "Name has leading or trailing spaces." });
  }
  if (/ {2,}/.test(normalized)) {
    issues.push({ code: "double-space", severity: "warning", message: "Name has two spaces in a row." });
  }

  return { normalized, length, issues, ok: !issues.some((i) => i.severity === "error") };
}

export class NameValidationError extends AppError {
  constructor(
    readonly check: NameCheck,
    readonly slot?: number,
  ) {
    const where = slot === undefined ? "" : ` (slot ${slot})`;
    const errors = check.issues.filter((i) => i.severity === "error").map((i) => i.message);
    super("invalid-name", `Invalid name${where}: ${errors.join(" ")}`, slot === undefined ? {} : { slot });
  }
}
