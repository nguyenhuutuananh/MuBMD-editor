// jsonText.ts - A small JSON parser that remembers where every value sits in the text, so a single
// value (an item's "name") can be replaced without touching any other byte of the file. Plus the
// string escaping of nlohmann::json's dump(), which MuMain uses to write the item files.

export type JsonNode =
  | { kind: "object"; start: number; end: number; entries: [string, JsonNode][] }
  | { kind: "array"; start: number; end: number; items: JsonNode[] }
  | { kind: "string"; start: number; end: number; value: string }
  | { kind: "number"; start: number; end: number; value: number }
  | { kind: "literal"; start: number; end: number; value: boolean | null };

export class JsonSyntaxError extends Error {
  constructor(
    message: string,
    readonly line: number,
    readonly column: number,
  ) {
    super(`${message} (line ${line}, column ${column})`);
  }
}

// `start`/`end` are UTF-16 offsets into the text (end is exclusive).
export function parseJsonText(text: string): JsonNode {
  let i = 0;

  const fail = (msg: string): never => {
    const before = text.slice(0, i);
    const line = before.split("\n").length;
    throw new JsonSyntaxError(msg, line, i - before.lastIndexOf("\n"));
  };
  const ws = () => {
    while (i < text.length && " \t\r\n".includes(text[i]!)) i++;
  };
  const expect = (ch: string) => {
    if (text[i] !== ch) fail(`expected "${ch}"`);
    i++;
  };

  function str(): string {
    expect('"');
    let out = "";
    for (;;) {
      if (i >= text.length) fail("unterminated string");
      const c = text[i++]!;
      if (c === '"') return out;
      if (c < " ") fail("control character in string");
      if (c !== "\\") {
        out += c;
        continue;
      }
      const e = text[i++];
      switch (e) {
        case '"':
        case "\\":
        case "/":
          out += e;
          break;
        case "b":
          out += "\b";
          break;
        case "f":
          out += "\f";
          break;
        case "n":
          out += "\n";
          break;
        case "r":
          out += "\r";
          break;
        case "t":
          out += "\t";
          break;
        case "u": {
          const hex = text.slice(i, i + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail("bad \\u escape");
          out += String.fromCharCode(parseInt(hex, 16));
          i += 4;
          break;
        }
        default:
          i--;
          fail("bad escape");
      }
    }
  }

  function value(): JsonNode {
    ws();
    const start = i;
    const c = text[i];
    if (c === "{") {
      i++;
      const entries: [string, JsonNode][] = [];
      ws();
      if (text[i] === "}") {
        i++;
        return { kind: "object", start, end: i, entries };
      }
      for (;;) {
        ws();
        const key = str();
        ws();
        expect(":");
        entries.push([key, value()]);
        ws();
        if (text[i] === ",") {
          i++;
          continue;
        }
        expect("}");
        return { kind: "object", start, end: i, entries };
      }
    }
    if (c === "[") {
      i++;
      const items: JsonNode[] = [];
      ws();
      if (text[i] === "]") {
        i++;
        return { kind: "array", start, end: i, items };
      }
      for (;;) {
        items.push(value());
        ws();
        if (text[i] === ",") {
          i++;
          continue;
        }
        expect("]");
        return { kind: "array", start, end: i, items };
      }
    }
    if (c === '"') {
      const s = str();
      return { kind: "string", start, end: i, value: s };
    }
    const m = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(text.slice(i, i + 40));
    if (m) {
      i += m[0].length;
      return { kind: "number", start, end: i, value: Number(m[0]) };
    }
    for (const [word, v] of [
      ["true", true],
      ["false", false],
      ["null", null],
    ] as const) {
      if (text.startsWith(word, i)) {
        i += word.length;
        return { kind: "literal", start, end: i, value: v };
      }
    }
    return fail(i >= text.length ? "unexpected end of file" : `unexpected "${c}"`);
  }

  const root = value();
  ws();
  if (i < text.length) fail("unexpected text after the end");
  return root;
}

export const member = (node: JsonNode | undefined, key: string): JsonNode | undefined =>
  node?.kind === "object" ? node.entries.find(([k]) => k === key)?.[1] : undefined;

// nlohmann::json dump(..., ensure_ascii = false): only '"', '\' and control characters are escaped;
// everything else (Vietnamese letters included) is written as raw UTF-8.
export function jsonString(s: string): string {
  let out = '"';
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\b") out += "\\b";
    else if (ch === "\f") out += "\\f";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (code < 0x20) out += `\\u${code.toString(16).padStart(4, "0")}`;
    else out += ch;
  }
  return `${out}"`;
}
