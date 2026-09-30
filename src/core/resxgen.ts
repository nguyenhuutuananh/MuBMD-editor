// resxgen.ts - What MuMain's ResxGen (tools/ResxGen) does with the default-locale (en) file,
// ported so the tool can report a failing build before anyone runs CMake.
//
//   Naming.ToIdentifier     key -> PascalCase C++ identifier ("" = the entry is skipped)
//   ResxLoader.BuildEntries throws when an identifier is longer than 64 characters, when two
//                           keys slug to the same identifier, or when a legacy_id is used twice;
//                           a key that is only whitespace makes ToIdentifier throw.
//
// ResxGen stops at the first error; this reports all of them.

import { resxValues, type ResxDocument } from "./resx";

export const MAX_IDENTIFIER_LENGTH = 64;

const isAsciiAlnum = (c: string) => /^[A-Za-z0-9]$/.test(c);

// Port of Naming.ToIdentifier. Returns "" when no identifier survives (ResxGen skips the entry
// with a warning). A blank key throws in ResxGen: check `isBlankKey` first.
export function toIdentifier(key: string): string {
  let id = "";
  let atWordStart = true;
  for (const c of key) {
    if (c.length === 1 && isAsciiAlnum(c)) {
      id += atWordStart ? c.toUpperCase() : c;
      atWordStart = false;
    } else {
      atWordStart = true;
    }
  }
  if (id === "") return "";
  // "%s" -> "S" is kept, but a one-letter slug of a non-ASCII (garbled Korean) key is dropped.
  if (id.length < 2 && /[^\u0000-\u007f]/.test(key)) return "";
  if (/^[0-9]/.test(id)) id = "_" + id;
  return id;
}

// ArgumentException.ThrowIfNullOrWhiteSpace. char.IsWhiteSpace differs from JS \s on two
// characters: U+0085 is whitespace in .NET, U+FEFF is not.
export const isBlankKey = (key: string): boolean => /^[\s\u0085]*$/.test(key.replace(/﻿/g, "x"));

export type BuildIssueCode =
  | "blank-key" // build error
  | "identifier-too-long" // build error
  | "identifier-collision" // build error
  | "legacy-id-collision" // build error
  | "no-identifier"; // skipped by ResxGen: the string can never be shown

export interface BuildIssue {
  code: BuildIssueCode;
  key: string;
  line: number;
  params: Record<string, string | number>;
}

export interface BuildCheck {
  issues: BuildIssue[];
  identifiers: Map<string, string>; // key -> identifier, for the keys ResxGen emits
}

// Checks the en document of one group, in ResxGen's order (first appearance of each key).
export function checkBuild(en: ResxDocument): BuildCheck {
  const issues: BuildIssue[] = [];
  const identifiers = new Map<string, string>();
  const byIdentifier = new Map<string, string>();
  const byLegacyId = new Map<number, string>();
  for (const entry of resxValues(en).values()) {
    const { key, line } = entry;
    if (isBlankKey(key)) {
      issues.push({ code: "blank-key", key, line, params: {} });
      continue;
    }
    const id = toIdentifier(key);
    if (id === "") {
      issues.push({ code: "no-identifier", key, line, params: {} });
      continue;
    }
    if (id.length > MAX_IDENTIFIER_LENGTH) {
      issues.push({ code: "identifier-too-long", key, line, params: { identifier: id, length: id.length, max: MAX_IDENTIFIER_LENGTH } });
      continue;
    }
    const first = byIdentifier.get(id);
    if (first !== undefined) {
      issues.push({ code: "identifier-collision", key, line, params: { identifier: id, other: first } });
      continue;
    }
    byIdentifier.set(id, key);
    for (const legacyId of entry.legacyIds) {
      const owner = byLegacyId.get(legacyId);
      if (owner !== undefined) issues.push({ code: "legacy-id-collision", key, line, params: { legacyId, other: owner } });
      else byLegacyId.set(legacyId, key);
    }
    identifiers.set(key, id);
  }
  return { issues, identifiers };
}
