// xml.ts - A small, position-keeping XML tokenizer: just enough for .resx files, pure logic.
//
// No DOM: Bun has no DOMParser, and the writer needs the byte offsets of every token so it can
// rewrite one <value> and copy everything else verbatim. The tokenizer is strict where
// ResxGen's XDocument.Load() is strict (mismatched tags, unknown entities, "--" in comments,
// control characters...), so a file this tool accepts is one the MuMain build accepts too.

import { AppError } from "./errors";

export interface XmlAttr {
  name: string;
  value: string; // decoded + normalized like an XML parser does
}

export type XmlToken =
  | { kind: "text"; start: number; end: number }
  | { kind: "cdata"; start: number; end: number } // content = src.slice(start + 9, end - 3)
  | { kind: "comment"; start: number; end: number }
  | { kind: "pi"; target: string; start: number; end: number }
  | { kind: "start"; name: string; attrs: XmlAttr[]; selfClosing: boolean; start: number; end: number }
  | { kind: "end"; name: string; start: number; end: number };

// 1-based line / column of `offset` in `src` (for error messages).
export function lineColumn(src: string, offset: number): { line: number; column: number } {
  let line = 1;
  let lineStart = 0;
  for (let i = src.indexOf("\n"); i !== -1 && i < offset; i = src.indexOf("\n", i + 1)) {
    line++;
    lineStart = i + 1;
  }
  return { line, column: offset - lineStart + 1 };
}

export function xmlError(src: string, offset: number, detail: string): AppError {
  const { line, column } = lineColumn(src, offset);
  return new AppError("resx-xml", `XML error at line ${line}, column ${column}: ${detail}`, { line, column, detail });
}

export function isXmlChar(cp: number): boolean {
  return (
    cp === 0x9 ||
    cp === 0xa ||
    cp === 0xd ||
    (cp >= 0x20 && cp <= 0xd7ff) ||
    (cp >= 0xe000 && cp <= 0xfffd) ||
    (cp >= 0x10000 && cp <= 0x10ffff)
  );
}

// Characters XML 1.0 forbids anywhere in a document (lone surrogates cannot occur: text comes
// from a fatal UTF-8 decode).
const FORBIDDEN_CHAR = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/;

const NAMED_ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

// Expands entity / character references. `fail(i, detail)` reports a bad reference at index i
// of `raw` (it must throw).
export function decodeRefs(raw: string, fail: (i: number, detail: string) => never): string {
  let amp = raw.indexOf("&");
  if (amp === -1) return raw;
  let out = "";
  let from = 0;
  while (amp !== -1) {
    const semi = raw.indexOf(";", amp);
    if (semi === -1 || semi - amp > 12) fail(amp, "'&' must start an entity reference such as &amp;");
    const ref = raw.slice(amp + 1, semi);
    let ch: string;
    if (ref.startsWith("#")) {
      const hex = ref[1] === "x";
      const digits = ref.slice(hex ? 2 : 1);
      if (!(hex ? /^[0-9a-fA-F]+$/ : /^[0-9]+$/).test(digits)) fail(amp, `invalid character reference &${ref};`);
      const cp = parseInt(digits, hex ? 16 : 10);
      if (!isXmlChar(cp)) fail(amp, `character reference &${ref}; is not a legal XML character`);
      ch = String.fromCodePoint(cp);
    } else {
      const named = NAMED_ENTITIES[ref];
      if (named === undefined) fail(amp, `unknown entity &${ref};`);
      ch = named;
    }
    out += raw.slice(from, amp) + ch;
    from = semi + 1;
    amp = raw.indexOf("&", from);
  }
  return out + raw.slice(from);
}

// XML end-of-line handling: CRLF and lone CR become LF (before references are expanded, so a
// written &#xD; survives).
export const normalizeEol = (raw: string): string => raw.replace(/\r\n?/g, "\n");

export function decodeText(raw: string, fail: (i: number, detail: string) => never): string {
  // Offsets reported by `fail` refer to the normalized string; close enough for a message.
  return decodeRefs(normalizeEol(raw), fail);
}

export function decodeAttr(raw: string, fail: (i: number, detail: string) => never): string {
  return decodeRefs(normalizeEol(raw).replace(/[\t\n]/g, " "), fail);
}

function checkChars(v: string): void {
  const m = FORBIDDEN_CHAR.exec(v);
  if (m) {
    const hex = m[0].codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0");
    throw new AppError("resx-invalid-char", `U+${hex} cannot be stored in an XML file`, { char: `U+${hex}` });
  }
}

// Element text as written by this tool: only what must be escaped is escaped, so a value that
// never had entities stays readable in a diff. A CR is written as &#xD; (a raw one would be
// turned into LF by the next reader).
export function escapeText(v: string): string {
  checkChars(v);
  return v.replace(/[&<>\r]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&#xD;"));
}

export function escapeAttr(v: string): string {
  checkChars(v);
  return v.replace(/[&<>"\t\n\r]/g, (c) => ATTR_ESCAPES[c]!);
}

const ATTR_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "\t": "&#x9;",
  "\n": "&#xA;",
  "\r": "&#xD;",
};

const NAME = /[A-Za-z_:À-￿][-A-Za-z0-9_:.·À-￿]*/y;
const SPACE = /[ \t\r\n]*/y;

// Splits a whole document into tokens. Checks the lexical rules; nesting is checked by the
// caller (it has to walk the tokens anyway).
export function tokenizeXml(src: string): XmlToken[] {
  const bad = FORBIDDEN_CHAR.exec(src);
  if (bad) {
    const hex = bad[0].codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0");
    throw xmlError(src, bad.index, `character U+${hex} is not allowed in XML`);
  }

  const tokens: XmlToken[] = [];
  let i = 0;
  const n = src.length;

  const readName = (at: number, what: string): string => {
    NAME.lastIndex = at;
    const m = NAME.exec(src);
    if (!m) throw xmlError(src, at, `expected ${what}`);
    return m[0];
  };
  const skipSpace = (at: number): number => {
    SPACE.lastIndex = at;
    SPACE.exec(src);
    return SPACE.lastIndex;
  };
  const find = (needle: string, from: number, start: number, what: string): number => {
    const k = src.indexOf(needle, from);
    if (k === -1) throw xmlError(src, start, `unterminated ${what}`);
    return k;
  };

  while (i < n) {
    if (src.charCodeAt(i) !== 0x3c /* < */) {
      let end = src.indexOf("<", i);
      if (end === -1) end = n;
      const raw = src.slice(i, end);
      const cdataEnd = raw.indexOf("]]>");
      if (cdataEnd !== -1) throw xmlError(src, i + cdataEnd, "']]>' is not allowed in text");
      const base = i;
      decodeText(raw, (k, d) => {
        throw xmlError(src, base + k, d);
      });
      tokens.push({ kind: "text", start: i, end });
      i = end;
      continue;
    }

    const start = i;
    if (src.startsWith("<!--", i)) {
      const close = find("-->", i + 4, start, "comment");
      const body = src.slice(i + 4, close);
      if (body.includes("--") || body.endsWith("-")) throw xmlError(src, start, "'--' is not allowed inside a comment");
      i = close + 3;
      tokens.push({ kind: "comment", start, end: i });
    } else if (src.startsWith("<![CDATA[", i)) {
      i = find("]]>", i + 9, start, "CDATA section") + 3;
      tokens.push({ kind: "cdata", start, end: i });
    } else if (src.startsWith("<?", i)) {
      const target = readName(i + 2, "a processing instruction name");
      if (target.toLowerCase() === "xml" && start !== 0) {
        throw xmlError(src, start, "the XML declaration must be at the very start of the file");
      }
      i = find("?>", i + 2 + target.length, start, "processing instruction") + 2;
      tokens.push({ kind: "pi", target, start, end: i });
    } else if (src.startsWith("<!", i)) {
      throw xmlError(src, start, src.startsWith("<!DOCTYPE", i) ? "DOCTYPE is not supported" : "unexpected '<!'");
    } else if (src.startsWith("</", i)) {
      const name = readName(i + 2, "an element name");
      i = skipSpace(i + 2 + name.length);
      if (src[i] !== ">") throw xmlError(src, i, `expected '>' to close </${name}`);
      i++;
      tokens.push({ kind: "end", name, start, end: i });
    } else {
      const name = readName(i + 1, "an element name");
      i += 1 + name.length;
      const attrs: XmlAttr[] = [];
      for (;;) {
        const afterSpace = skipSpace(i);
        const c = src[afterSpace];
        if (c === ">" || (c === "/" && src[afterSpace + 1] === ">")) {
          const selfClosing = c === "/";
          i = afterSpace + (selfClosing ? 2 : 1);
          tokens.push({ kind: "start", name, attrs, selfClosing, start, end: i });
          break;
        }
        if (afterSpace === i) throw xmlError(src, i, `expected whitespace, '>' or '/>' in <${name}>`);
        const attrName = readName(afterSpace, "an attribute name");
        let k = skipSpace(afterSpace + attrName.length);
        if (src[k] !== "=") throw xmlError(src, k, `expected '=' after attribute ${attrName}`);
        k = skipSpace(k + 1);
        const quote = src[k];
        if (quote !== '"' && quote !== "'") throw xmlError(src, k, `attribute ${attrName} must be quoted`);
        const close = find(quote, k + 1, k, `attribute ${attrName}`);
        const raw = src.slice(k + 1, close);
        const lt = raw.indexOf("<");
        if (lt !== -1) throw xmlError(src, k + 1 + lt, `'<' is not allowed in attribute ${attrName}`);
        if (attrs.some((a) => a.name === attrName)) throw xmlError(src, afterSpace, `duplicate attribute ${attrName}`);
        const base = k + 1;
        attrs.push({
          name: attrName,
          value: decodeAttr(raw, (j, d) => {
            throw xmlError(src, base + j, d);
          }),
        });
        i = close + 1;
      }
    }
  }
  return tokens;
}
