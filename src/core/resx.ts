// resx.ts - Read / edit / write MuMain .resx files without disturbing their formatting.
//
// A document is kept as the original text cut into parts: every direct <data> child of <root>
// is one part, everything else (declaration, resheaders, whitespace, comments, </root>) stays in
// the text parts between them. Parts alternate: text, data, text, ..., data, text.
// Writing concatenates the parts, so:
//   - an unedited document is written back byte for byte;
//   - editing a value rewrites only the characters between <value> and </value>;
//   - removing an entry removes the entry and the line break + indent in front of it;
//   - a new entry is inserted after the nearest earlier key of a reference order (the en file),
//     with the file's own indentation and line endings.
//
// The meaning of each entry follows ResxGen (MuMain/tools/ResxGen/ResxLoader.cs): only direct
// <data> children of <root> count, names starting with ">>" are skipped, the text of the first
// <value> child is the string, and when a key appears twice the last one wins.
//
// All functions are pure: an edit returns a new document and leaves the old one untouched.

import { AppError } from "./errors";
import { decodeText, escapeAttr, escapeText, lineColumn, normalizeEol, tokenizeXml, xmlError, type XmlToken } from "./xml";

export interface ResxEntry {
  readonly key: string;
  readonly value: string;
  readonly comment: string | null;
  readonly legacyIds: readonly number[]; // from <comment>legacy_id=N,N,...</comment>
  readonly line: number; // 1-based line of <data> in the file as parsed (0 for entries added since)
  readonly kind: "string" | "metadata" | "typed"; // metadata: ">>" name; typed: type= / mimetype=
  readonly editable: boolean; // the value is plain text (and the entry is a string)
}

interface ValueRange {
  start: number; // offset of the value text in `raw` (for a self-closing <value/>: the tag itself)
  end: number;
  selfClosing: boolean;
  elementEnd: number; // just after </value> (or <value/>): where a new <comment> goes
}

interface CommentRange {
  elementStart: number; // the whole <comment>...</comment> element in `raw`
  elementEnd: number;
  plain: boolean; // only text inside (so it can be rewritten)
}

export interface ResxTextPart {
  readonly kind: "text";
  readonly raw: string;
}

export interface ResxDataPart {
  readonly kind: "data";
  readonly raw: string;
  readonly entry: ResxEntry | null; // null: <data> without a name (ignored by ResxGen)
  readonly value: ValueRange | null; // null: no <value> child
  readonly commentRange: CommentRange | null; // null: no <comment> child
}

export type ResxPart = ResxTextPart | ResxDataPart;

export interface ResxStyle {
  readonly eol: "\n" | "\r\n";
  readonly indent: string; // before <data>
  readonly childIndent: string; // before <value> / <comment>
}

export interface ResxDocument {
  readonly bom: boolean;
  readonly style: ResxStyle;
  readonly parts: readonly ResxPart[];
  // Length of the final text from </root> to the end of the file; new entries go in front of it.
  // null for a self-closing <root/> (nothing can be inserted there).
  readonly tailLength: number | null;
}

export interface ResxProblem {
  code: "duplicate-key" | "missing-name";
  line: number;
  key?: string;
}

const METADATA_PREFIX = ">>";
const LEGACY_ID = /legacy_id\s*=\s*([0-9]+(?:\s*,\s*[0-9]+)*)/i;
const DEFAULT_STYLE: ResxStyle = { eol: "\n", indent: "  ", childIndent: "    " };

export function parseLegacyIds(comment: string | null): number[] {
  const m = comment ? LEGACY_ID.exec(comment) : null;
  if (!m) return [];
  return m[1]!
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "")
    .map(Number);
}

// ---------------------------------------------------------------------------------------------
// Reading

function decodeBytes(bytes: Uint8Array): string {
  if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff)) {
    throw new AppError("resx-encoding", "UTF-16 files are not supported; save the file as UTF-8", { encoding: "UTF-16" });
  }
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new AppError("resx-encoding", "The file is not valid UTF-8", { encoding: "?" });
  }
}

export function parseResx(input: Uint8Array | string): ResxDocument {
  let src = typeof input === "string" ? input : decodeBytes(input);
  const bom = src.startsWith("﻿");
  if (bom) src = src.slice(1);

  const tokens = tokenizeXml(src);
  const fail = (at: number, detail: string): never => {
    throw xmlError(src, at, detail);
  };

  const decl = tokens[0]?.kind === "pi" && tokens[0].target.toLowerCase() === "xml" ? tokens[0] : null;
  if (decl) {
    const enc = /encoding\s*=\s*["']([^"']*)["']/.exec(src.slice(decl.start, decl.end))?.[1];
    if (enc !== undefined && !/^utf-?8$/i.test(enc)) {
      throw new AppError("resx-encoding", `The file declares encoding "${enc}"; only UTF-8 is supported`, { encoding: enc });
    }
  }

  // Walk the tree: find <root>, its direct <data> children, and </root>.
  const dataRanges: Array<{ first: number; last: number }> = []; // token indexes
  const stack: string[] = [];
  let rootSeen = false;
  let rootClose: number | null = null; // offset of </root>
  let dataStart = -1;
  for (let t = 0; t < tokens.length; t++) {
    const tok = tokens[t]!;
    if (tok.kind === "start") {
      if (stack.length === 0) {
        if (rootSeen) fail(tok.start, "only one root element is allowed");
        rootSeen = true;
        if (tok.name !== "root") {
          throw new AppError("resx-root", `The root element is <${tok.name}>, expected <root>`, { name: tok.name });
        }
      } else if (stack.length === 1 && tok.name === "data") {
        dataStart = t;
        if (tok.selfClosing) dataRanges.push({ first: t, last: t });
      }
      if (!tok.selfClosing) stack.push(tok.name);
    } else if (tok.kind === "end") {
      const open = stack.pop();
      if (open === undefined) fail(tok.start, `unexpected </${tok.name}>`);
      if (open !== tok.name) fail(tok.start, `</${tok.name}> does not match <${open}>`);
      if (stack.length === 1 && tok.name === "data") dataRanges.push({ first: dataStart, last: t });
      if (stack.length === 0) rootClose = tok.start;
    } else if (stack.length === 0) {
      if (tok.kind === "text" && src.slice(tok.start, tok.end).trim() !== "") {
        fail(tok.start, "text is not allowed outside the root element");
      }
      if (tok.kind === "cdata") fail(tok.start, "CDATA is not allowed outside the root element");
    }
  }
  if (stack.length > 0) fail(src.length, `<${stack[stack.length - 1]}> is never closed`);
  if (!rootSeen) throw new AppError("resx-root", "The file has no <root> element", { name: "" });

  // Cut the text into parts. Line numbers are counted incrementally (the files are long).
  const parts: ResxPart[] = [];
  let pos = 0;
  let lineAt = 0;
  let line = 1;
  const lineOf = (offset: number): number => {
    for (let k = src.indexOf("\n", lineAt); k !== -1 && k < offset; k = src.indexOf("\n", k + 1)) {
      line++;
      lineAt = k + 1;
    }
    return line;
  };
  for (const r of dataRanges) {
    const first = tokens[r.first]!;
    const last = tokens[r.last]!;
    parts.push({ kind: "text", raw: src.slice(pos, first.start) });
    parts.push(readData(src, tokens, r.first, r.last, lineOf(first.start)));
    pos = last.end;
  }
  parts.push({ kind: "text", raw: src.slice(pos) });

  return {
    bom,
    style: detectStyle(src, parts),
    parts,
    tailLength: rootClose === null ? null : src.length - rootClose,
  };
}

// Builds one data part from tokens[first..last] (the <data> start tag .. its end tag).
function readData(src: string, tokens: XmlToken[], first: number, last: number, line: number): ResxDataPart {
  const open = tokens[first]!;
  if (open.kind !== "start") throw new Error("readData: not a start tag");
  const base = open.start;
  const raw = src.slice(base, tokens[last]!.end);
  const attr = (name: string) => open.attrs.find((a) => a.name === name)?.value;

  let value: string | null = null;
  let valueRange: ValueRange | null = null;
  let plain = true;
  let comment: string | null = null;
  let commentRange: CommentRange | null = null;

  // Direct children of <data>: the first <value> and the first <comment> are read.
  for (let t = first + 1; t < last; t++) {
    const tok = tokens[t]!;
    if (tok.kind !== "start") continue;
    const close = tok.selfClosing ? t : matchingEnd(tokens, t);
    const want = (tok.name === "value" && value === null) || (tok.name === "comment" && comment === null);
    if (want) {
      let text = "";
      let nested = false;
      for (let k = t + 1; k < close; k++) {
        const inner = tokens[k]!;
        if (inner.kind === "text") {
          text += decodeText(src.slice(inner.start, inner.end), (i, d) => {
            throw xmlError(src, inner.start + i, d);
          });
        } else if (inner.kind === "cdata") {
          text += normalizeEol(src.slice(inner.start + 9, inner.end - 3));
        } else if (inner.kind === "start") {
          nested = true;
        }
      }
      if (tok.name === "value") {
        value = text;
        plain = !nested;
        valueRange = tok.selfClosing
          ? { start: tok.start - base, end: tok.end - base, selfClosing: true, elementEnd: tok.end - base }
          : { start: tok.end - base, end: tokens[close]!.start - base, selfClosing: false, elementEnd: tokens[close]!.end - base };
      } else {
        comment = text;
        commentRange = { elementStart: tok.start - base, elementEnd: tokens[close]!.end - base, plain: !nested };
      }
    }
    t = close;
  }

  const key = attr("name");
  if (key === undefined || key === "") return { kind: "data", raw, entry: null, value: valueRange, commentRange };
  const kind = key.startsWith(METADATA_PREFIX)
    ? "metadata"
    : attr("type") !== undefined || attr("mimetype") !== undefined
      ? "typed"
      : "string";
  return {
    kind: "data",
    raw,
    entry: {
      key,
      value: value ?? "",
      comment,
      legacyIds: parseLegacyIds(comment),
      line,
      kind,
      editable: kind === "string" && plain,
    },
    value: valueRange,
    commentRange,
  };
}

// Reads one <data> element again after its text was changed (offsets and entry recomputed).
function reparse(raw: string, line: number): ResxDataPart {
  const doc = parseResx(`<root>${raw}</root>`);
  const part = doc.parts[1] as ResxDataPart;
  return part.entry ? { ...part, entry: { ...part.entry, line } } : part;
}

function matchingEnd(tokens: XmlToken[], startIndex: number): number {
  let depth = 0;
  for (let t = startIndex; t < tokens.length; t++) {
    const tok = tokens[t]!;
    if (tok.kind === "start" && !tok.selfClosing) depth++;
    else if (tok.kind === "end" && --depth === 0) return t;
  }
  throw new Error("matchingEnd: unbalanced tokens"); // the tree walk has already checked this
}

function detectStyle(src: string, parts: ResxPart[]): ResxStyle {
  const eol = src.includes("\r\n") ? "\r\n" : "\n";
  for (let i = 1; i < parts.length; i += 2) {
    const data = parts[i] as ResxDataPart;
    const child = /\n([ \t]*)<value\b/.exec(data.raw);
    if (!child) continue;
    const before = parts[i - 1]!.raw;
    const indent = /\n([ \t]*)$/.exec(before)?.[1] ?? DEFAULT_STYLE.indent;
    return { eol, indent, childIndent: child[1]! };
  }
  return { ...DEFAULT_STYLE, eol };
}

// ---------------------------------------------------------------------------------------------
// Queries

export function resxToString(doc: ResxDocument): string {
  return (doc.bom ? "﻿" : "") + doc.parts.map((p) => p.raw).join("");
}

export function serializeResx(doc: ResxDocument): Uint8Array {
  return new TextEncoder().encode(resxToString(doc));
}

// Every named entry, in file order (duplicates included).
export function resxEntries(doc: ResxDocument): ResxEntry[] {
  const out: ResxEntry[] = [];
  for (const p of doc.parts) if (p.kind === "data" && p.entry) out.push(p.entry);
  return out;
}

// The strings ResxGen sees: metadata entries skipped, the last duplicate wins. Map order is the
// order of first appearance.
export function resxValues(doc: ResxDocument): Map<string, ResxEntry> {
  const map = new Map<string, ResxEntry>();
  for (const e of resxEntries(doc)) if (e.kind !== "metadata") map.set(e.key, e);
  return map;
}

export function findResxProblems(doc: ResxDocument): ResxProblem[] {
  const problems: ResxProblem[] = [];
  const seen = new Set<string>();
  for (const p of doc.parts) {
    if (p.kind !== "data") continue;
    if (!p.entry) {
      problems.push({ code: "missing-name", line: lineOfPart(doc, p) });
      continue;
    }
    if (seen.has(p.entry.key)) problems.push({ code: "duplicate-key", line: p.entry.line, key: p.entry.key });
    seen.add(p.entry.key);
  }
  return problems;
}

function lineOfPart(doc: ResxDocument, part: ResxPart): number {
  const text = resxToString(doc);
  let offset = doc.bom ? 1 : 0;
  for (const p of doc.parts) {
    if (p === part) break;
    offset += p.raw.length;
  }
  return lineColumn(text, offset).line;
}

// ---------------------------------------------------------------------------------------------
// Editing

export interface SetValueOptions {
  // Key order of the reference file (en). A new key goes after the nearest earlier key of this
  // order that the document has (or before the nearest later one); without it, at the end.
  order?: readonly string[];
  // <comment> for a new entry (e.g. the en entry's "legacy_id=12"); existing comments are kept.
  comment?: string | null;
}

function buildData(style: ResxStyle, key: string, value: string, comment: string | null): ResxDataPart {
  const { eol, indent, childIndent } = style;
  const head = `<data name="${escapeAttr(key)}" xml:space="preserve">${eol}${childIndent}<value>`;
  const text = escapeText(value);
  const tail =
    `</value>${eol}` + (comment !== null ? `${childIndent}<comment>${escapeText(comment)}</comment>${eol}` : "") + `${indent}</data>`;
  return reparse(head + text + tail, 0);
}

function lastIndexOfKey(parts: readonly ResxPart[]): Map<string, number> {
  const map = new Map<string, number>();
  parts.forEach((p, i) => {
    if (p.kind === "data" && p.entry) map.set(p.entry.key, i);
  });
  return map;
}

export function setResxValue(doc: ResxDocument, key: string, value: string, opts: SetValueOptions = {}): ResxDocument {
  if (key === "" || key.startsWith(METADATA_PREFIX)) {
    throw new AppError("resx-not-editable", `"${key}" is not a string entry`, { key });
  }
  const index = lastIndexOfKey(doc.parts);
  const at = index.get(key);
  if (at !== undefined) return replaceValue(doc, at, value);

  const part = buildData(doc.style, key, value, opts.comment ?? null);
  const gap: ResxTextPart = { kind: "text", raw: doc.style.eol + doc.style.indent };
  const order = opts.order ?? [];
  const pos = order.indexOf(key);
  if (pos !== -1) {
    for (let k = pos - 1; k >= 0; k--) {
      const prev = index.get(order[k]!);
      if (prev !== undefined) return splice(doc, prev + 1, 0, gap, part);
    }
    for (let k = pos + 1; k < order.length; k++) {
      const next = index.get(order[k]!);
      if (next !== undefined) {
        // Before the first entry carrying that key, so duplicates stay together.
        const first = doc.parts.findIndex((p) => p.kind === "data" && p.entry?.key === order[k]);
        return splice(doc, first, 0, part, gap);
      }
    }
  }
  return append(doc, part);
}

function replaceValue(doc: ResxDocument, at: number, value: string): ResxDocument {
  const old = doc.parts[at] as ResxDataPart;
  const entry = old.entry!;
  if (!entry.editable) throw new AppError("resx-not-editable", `"${entry.key}" does not hold plain text`, { key: entry.key });
  if (entry.value === value && old.value) return doc;

  let next: ResxDataPart;
  if (!old.value) {
    // <data name="x"/> or no <value> child: write the entry anew, keeping its comment.
    next = buildData(doc.style, entry.key, value, entry.comment);
    next = { ...next, entry: { ...next.entry!, line: entry.line } };
  } else {
    const text = escapeText(value);
    const { start, end, selfClosing } = old.value;
    const inner = selfClosing ? `<value>${text}</value>` : text;
    next = reparse(old.raw.slice(0, start) + inner + old.raw.slice(end), entry.line);
  }
  return withPart(doc, at, next);
}

function withPart(doc: ResxDocument, at: number, part: ResxDataPart): ResxDocument {
  const parts = doc.parts.slice();
  parts[at] = part;
  return { ...doc, parts };
}

// Sets (or with null removes) the <comment> of an existing entry; only that element changes.
// A new comment goes on its own line after </value> when the entry is written one child per
// line, else right after it.
export function setResxComment(doc: ResxDocument, key: string, comment: string | null): ResxDocument {
  const at = lastIndexOfKey(doc.parts).get(key);
  if (at === undefined) return doc;
  const old = doc.parts[at] as ResxDataPart;
  const entry = old.entry!;
  if (entry.comment === comment) return doc;
  const range = old.commentRange;
  if (range && !range.plain) throw new AppError("resx-not-editable", `The comment of "${key}" does not hold plain text`, { key });
  const { eol, childIndent } = doc.style;
  const element = comment === null ? "" : `<comment>${escapeText(comment)}</comment>`;
  let raw: string;
  if (range) {
    let start = range.elementStart;
    // Removing: also drop the line break + indent in front of the element.
    if (comment === null) start = old.raw.slice(0, start).replace(/(\r?\n)?[ \t]*$/, "").length;
    raw = old.raw.slice(0, start) + element + old.raw.slice(range.elementEnd);
  } else if (old.value) {
    const pos = old.value.elementEnd;
    const multiline = /\n[ \t]*<value\b/.test(old.raw);
    raw = old.raw.slice(0, pos) + (multiline ? eol + childIndent : "") + element + old.raw.slice(pos);
  } else {
    return withPart(doc, at, { ...buildData(doc.style, key, entry.value, comment), entry: { ...entry, comment, legacyIds: parseLegacyIds(comment) } });
  }
  return withPart(doc, at, reparse(raw, entry.line));
}

function splice(doc: ResxDocument, at: number, remove: number, ...insert: ResxPart[]): ResxDocument {
  const parts = doc.parts.slice();
  parts.splice(at, remove, ...insert);
  return { ...doc, parts };
}

function append(doc: ResxDocument, part: ResxDataPart): ResxDocument {
  if (doc.tailLength === null) {
    throw new AppError("resx-not-editable", "Cannot add entries to an empty <root/> element", { key: part.entry!.key });
  }
  const { eol, indent } = doc.style;
  const last = doc.parts[doc.parts.length - 1] as ResxTextPart;
  const cut = last.raw.length - doc.tailLength;
  let before = last.raw.slice(0, cut).replace(/[ \t]*$/, "");
  if (!/\n$/.test(before)) before += eol;
  return splice(
    doc,
    doc.parts.length - 1,
    1,
    { kind: "text", raw: before + indent },
    part,
    { kind: "text", raw: eol + last.raw.slice(cut) },
  );
}

// Removes every entry named `key` (returns `doc` itself when there is none).
export function removeResxEntry(doc: ResxDocument, key: string): ResxDocument {
  return removeParts(doc, (p) => p.entry?.key === key);
}

// A document with the same header / formatting and no entries: the start of a new locale.
export function emptyResxLike(doc: ResxDocument): ResxDocument {
  return removeParts(doc, () => true);
}

function removeParts(doc: ResxDocument, match: (p: ResxDataPart) => boolean): ResxDocument {
  let changed = false;
  const parts: ResxPart[] = [doc.parts[0]!];
  for (let i = 1; i < doc.parts.length; i += 2) {
    const data = doc.parts[i] as ResxDataPart;
    const after = doc.parts[i + 1] as ResxTextPart;
    if (!match(data)) {
      parts.push(data, after);
      continue;
    }
    changed = true;
    // Drop the entry with the line break + indent in front of it; merge the texts around it.
    const before = parts.pop() as ResxTextPart;
    parts.push({ kind: "text", raw: before.raw.replace(/(\r?\n)?[ \t]*$/, "") + after.raw });
  }
  return changed ? { ...doc, parts } : doc;
}
