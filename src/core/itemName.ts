// itemName.ts - Checks for a translated item name (Data/Items/*.json), on top of the text checks
// every translation gets (validate.ts checkValue: line breaks, whitespace, NFC, same as English...).
//
// The game copies a name into the MAX_ITEM_NAME (50) wide-character ITEM_ATTRIBUTE::Name, so at most
// 49 characters are shown; MuMain counts them as wchar_t, i.e. UTF-16 code units on Windows, and cuts
// the rest. "||" separates the languages of MuMain's LocalizedString: a name holding it stops the
// game from starting. Control characters have no business in a name.

import { type ValueIssue, checkValue } from "./validate";

export const MAX_NAME_CHARS = 49;
export const NAME_SEPARATOR = "||";

// Length as the game counts it (UTF-16 code units of the NFC form).
export const nameLength = (name: string) => name.normalize("NFC").length;

// Item-only checks. Codes: name-too-long, name-separator, name-invalid-char.
export function itemNameIssues(value: string): ValueIssue[] {
  const out: ValueIssue[] = [];
  const length = nameLength(value);
  if (length > MAX_NAME_CHARS) out.push({ code: "name-too-long", params: { chars: length, max: MAX_NAME_CHARS } });
  if (value.includes(NAME_SEPARATOR)) out.push({ code: "name-separator", params: {} });
  // Line breaks are reported by checkValue (raw-newline); other control characters and broken
  // UTF-16 here.
  if (/[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f]/.test(value) || /\p{Cs}/u.test(value)) out.push({ code: "name-invalid-char", params: {} });
  return out;
}

// Everything checked for a translated item name.
export const checkItemName = (en: string, value: string): ValueIssue[] => [...checkValue(en, value), ...itemNameIssues(value)];

// Issues that would break the game (it refuses to start), so such a name is never stored.
export const BLOCKING_ITEM_ISSUES = new Set(["name-separator", "name-invalid-char"]);
