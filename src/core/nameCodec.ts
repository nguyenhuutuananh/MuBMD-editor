// nameCodec.ts - Decode / validate / encode item names (the UTF-8 Name[50] field).
//
// Unlike the old tool, an over-long name is NOT silently truncated; it is reported as an
// error so the translator knows and can shorten it.

import { AppError } from "./errors";
import { NAME_LEN } from "./format";

export const MAX_NAME_BYTES = NAME_LEN - 1; // leave 1 byte for 0x00

export type NameEncoding = "empty" | "utf-8" | "unknown";

export interface DecodedName {
  text: string;
  encoding: NameEncoding;
  byteLength: number;
}

const utf8Strict = new TextDecoder("utf-8", { fatal: true });
const utf8Lossy = new TextDecoder("utf-8");
const utf8Encoder = new TextEncoder();

// Non-UTF-8 names (original Japanese/Korean data) are flagged "unknown" and returned with
// U+FFFD replacement characters for display only - Bun ships no Shift_JIS/EUC-KR decoder,
// so we do not guess the encoding.
export function decodeName(raw: Uint8Array): DecodedName {
  let end = raw.indexOf(0);
  if (end === -1) end = raw.length;
  const bytes = raw.subarray(0, end);
  if (bytes.length === 0) return { text: "", encoding: "empty", byteLength: 0 };
  try {
    return { text: utf8Strict.decode(bytes), encoding: "utf-8", byteLength: bytes.length };
  } catch {
    return { text: utf8Lossy.decode(bytes), encoding: "unknown", byteLength: bytes.length };
  }
}

export type NameIssueCode = "too-long" | "control-char" | "lone-surrogate" | "edge-whitespace" | "double-space";

// The English `message` is only for logs; the UI translates `code` + `params`.
export interface NameIssue {
  code: NameIssueCode;
  severity: "error" | "warning";
  message: string;
  params?: Record<string, number>;
}

export interface NameCheck {
  normalized: string; // NFC form - the form written to the file
  bytes: Uint8Array;
  byteLength: number;
  issues: NameIssue[];
  ok: boolean; // no "error"-level issue
}

// Vietnamese typed in decomposed form (NFD, e.g. on macOS) takes more bytes and may render
// wrongly in the game font, so always normalize to NFC before counting bytes.
export function checkName(name: string): NameCheck {
  const normalized = name.normalize("NFC");
  const bytes = utf8Encoder.encode(normalized);
  const issues: NameIssue[] = [];

  if (bytes.length > MAX_NAME_BYTES) {
    issues.push({
      code: "too-long",
      severity: "error",
      message: `Name is ${bytes.length} bytes, over the ${MAX_NAME_BYTES}-byte limit.`,
      params: { bytes: bytes.length, max: MAX_NAME_BYTES },
    });
  }
  if (/[\u0000-\u001f\u007f]/.test(normalized)) {
    issues.push({ code: "control-char", severity: "error", message: "Name contains control characters (tab, newline, 0x00...)." });
  }
  if (/\p{Cs}/u.test(normalized)) {
    issues.push({ code: "lone-surrogate", severity: "error", message: "Name contains broken Unicode (lone surrogate)." });
  }
  if (normalized !== normalized.trim()) {
    issues.push({ code: "edge-whitespace", severity: "warning", message: "Name has leading or trailing spaces." });
  }
  if (/ {2,}/.test(normalized)) {
    issues.push({ code: "double-space", severity: "warning", message: "Name has two spaces in a row." });
  }

  return {
    normalized,
    bytes,
    byteLength: bytes.length,
    issues,
    ok: !issues.some((i) => i.severity === "error"),
  };
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

// Encode to exactly NAME_LEN bytes, zero-padded. Throws NameValidationError on errors.
export function encodeName(name: string, slot?: number): Uint8Array {
  const check = checkName(name);
  if (!check.ok) throw new NameValidationError(check, slot);
  const out = new Uint8Array(NAME_LEN);
  out.set(check.bytes, 0);
  return out;
}
