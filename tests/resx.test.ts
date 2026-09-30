import { describe, expect, test } from "bun:test";
import {
  AppError,
  emptyResxLike,
  findResxProblems,
  parseResx,
  removeResxEntry,
  resxEntries,
  resxToString,
  resxValues,
  serializeResx,
  setResxComment,
  setResxValue,
  type ErrorCode,
} from "../src/core";
import { EDITOR_EN, GAME_EN } from "./fixtures/sampleResx";

const keysOf = (src: string) => resxEntries(parseResx(src)).map((e) => e.key);
const GAME_ORDER = keysOf(GAME_EN);

function codeOf(fn: () => unknown): ErrorCode | undefined {
  try {
    fn();
  } catch (e) {
    if (e instanceof AppError) return e.code;
    throw e;
  }
  return undefined;
}

describe("parseResx", () => {
  test("reads keys, decoded values, comments and legacy ids", () => {
    const entries = resxEntries(parseResx(GAME_EN));
    expect(entries.map((e) => e.key)).toEqual(["Gulim", "~ <msg>: Message to party members", "Warning", "Event"]);
    expect(entries[1]!.value).toBe("~ <msg>: Message to party members");
    expect(entries[2]!.value).toBe("Warning!!! account(%s) ban!!\\n\\n Contact us."); // literal \n stays literal
    expect(entries[0]!.comment).toBe("legacy_id=0,18");
    expect(entries[0]!.legacyIds).toEqual([0, 18]);
    expect(entries[0]!.line).toBe(5);
    expect(entries.every((e) => e.kind === "string" && e.editable)).toBe(true);
  });

  test("round-trips byte for byte (both layouts, BOM, CRLF)", () => {
    for (const src of [GAME_EN, EDITOR_EN, "﻿" + GAME_EN, GAME_EN.replace(/\n/g, "\r\n")]) {
      const bytes = new TextEncoder().encode(src);
      expect(serializeResx(parseResx(bytes))).toEqual(bytes);
    }
  });

  test("detects style", () => {
    expect(parseResx(GAME_EN).style).toEqual({ eol: "\n", indent: "  ", childIndent: "    " });
    expect(parseResx(GAME_EN.replace(/\n/g, "\r\n")).style.eol).toBe("\r\n");
  });

  test("value forms: empty, self-closing, missing, CDATA, CRLF inside, entities", () => {
    const src = `<root>
  <data name="a"><value></value></data>
  <data name="b"><value /></data>
  <data name="c"><comment>only a comment</comment></data>
  <data name="d"><value><![CDATA[<b>&amp;</b>]]></value></data>
  <data name="e"><value>x\r\ny&#xD;&#65;&quot;&apos;</value></data>
</root>`;
    const v = resxValues(parseResx(src));
    expect(v.get("a")!.value).toBe("");
    expect(v.get("b")!.value).toBe("");
    expect(v.get("c")!.value).toBe("");
    expect(v.get("d")!.value).toBe("<b>&amp;</b>");
    expect(v.get("e")!.value).toBe("x\ny\rA\"'");
  });

  test("entry kinds like ResxGen: >> metadata skipped, typed entries read but not editable", () => {
    const src = `<root>
  <data name=">>x.Type"><value>System.String</value></data>
  <data name="img" type="System.Drawing.Bitmap" mimetype="application/x-microsoft.net.object.bytearray.base64"><value>AAAA</value></data>
  <data name="rich"><value>a<b>c</b></value></data>
</root>`;
    const doc = parseResx(src);
    const all = resxEntries(doc);
    expect(all.map((e) => e.kind)).toEqual(["metadata", "typed", "string"]);
    expect([...resxValues(doc).keys()]).toEqual(["img", "rich"]);
    expect(resxValues(doc).get("rich")!.value).toBe("ac");
    expect(all.map((e) => e.editable)).toEqual([false, false, false]);
    expect(codeOf(() => setResxValue(doc, "rich", "x"))).toBe("resx-not-editable");
    expect(codeOf(() => setResxValue(doc, "img", "x"))).toBe("resx-not-editable");
    expect(codeOf(() => setResxValue(doc, ">>y", "x"))).toBe("resx-not-editable");
  });

  test("only direct <data> children of <root> are entries", () => {
    const src = `<root><metadata><data name="inner"><value>x</value></data></metadata><data name="top"><value>y</value></data></root>`;
    expect(keysOf(src)).toEqual(["top"]);
    expect(resxToString(parseResx(src))).toBe(src);
  });

  test("duplicates: last one wins; problems are reported", () => {
    const src = `<root>
  <data name="k"><value>first</value></data>
  <data><value>nameless</value></data>
  <data name="k"><value>second</value></data>
</root>`;
    const doc = parseResx(src);
    expect(resxValues(doc).get("k")!.value).toBe("second");
    expect(findResxProblems(doc)).toEqual([
      { code: "missing-name", line: 3 },
      { code: "duplicate-key", line: 4, key: "k" },
    ]);
  });

  test("rejects what XDocument.Load rejects", () => {
    const bad: Array<[string, ErrorCode]> = [
      ["<root><data name='a'><value>x</data></root>", "resx-xml"],
      ["<root><data name='a'><value>&nbsp;</value></data></root>", "resx-xml"],
      ["<root><data name='a'><value>a & b</value></data></root>", "resx-xml"],
      ["<root><data name='a' name='b'/></root>", "resx-xml"],
      ["<root><data name=a/></root>", "resx-xml"],
      ["<root><!-- a -- b --></root>", "resx-xml"],
      ["<root>\u0001</root>", "resx-xml"],
      ["<root><value>&#1;</value></root>", "resx-xml"],
      ["<root></root><root></root>", "resx-xml"],
      ["<root></root>text", "resx-xml"],
      ["<root>", "resx-xml"],
      ["<!DOCTYPE root><root/>", "resx-xml"],
      ["<root/>\n<?xml version='1.0'?>", "resx-xml"],
      ["<other/>", "resx-root"],
      ["", "resx-root"],
      ["<?xml version='1.0' encoding='windows-1258'?><root/>", "resx-encoding"],
    ];
    for (const [src, code] of bad) expect([src, codeOf(() => parseResx(src))]).toEqual([src, code]);
  });

  test("error position", () => {
    try {
      parseResx("<root>\n  <data name='a'>\n    <value>x</valu>\n</root>");
      throw new Error("no error");
    } catch (e) {
      expect((e as AppError).params).toMatchObject({ line: 3, column: 13 });
    }
  });

  test("encodings", () => {
    expect(codeOf(() => parseResx(new Uint8Array([0xff, 0xfe, 0x3c, 0x00])))).toBe("resx-encoding");
    expect(codeOf(() => parseResx(new Uint8Array([0x3c, 0x72, 0xc3, 0x28])))).toBe("resx-encoding");
    const doc = parseResx(new TextEncoder().encode("﻿<root/>"));
    expect(doc.bom).toBe(true);
    expect(serializeResx(doc)).toEqual(new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("<root/>")]));
  });
});

describe("setResxValue", () => {
  test("changes only the value text", () => {
    const doc = parseResx(GAME_EN);
    const out = resxToString(setResxValue(doc, "Event", "Sự kiện"));
    expect(out).toBe(GAME_EN.replace("<value>Event</value>", "<value>Sự kiện</value>"));
  });

  test("escapes only what must be escaped; keeps the old document", () => {
    const doc = parseResx(GAME_EN);
    const next = setResxValue(doc, "Event", `a < b & "c" > d\r\ne\tf`);
    expect(resxToString(next)).toContain(`<value>a &lt; b &amp; "c" &gt; d&#xD;\ne\tf</value>`);
    expect(resxValues(parseResx(resxToString(next))).get("Event")!.value).toBe(`a < b & "c" > d\r\ne\tf`);
    expect(resxToString(doc)).toBe(GAME_EN);
  });

  test("same value: the document is returned untouched (entities as written are kept)", () => {
    const doc = parseResx(GAME_EN);
    expect(setResxValue(doc, "~ <msg>: Message to party members", "~ <msg>: Message to party members")).toBe(doc);
  });

  test("edits the entry that wins (the last duplicate)", () => {
    const src = `<root>\n  <data name="k"><value>1</value></data>\n  <data name="k"><value>2</value></data>\n</root>`;
    expect(resxToString(setResxValue(parseResx(src), "k", "3"))).toBe(src.replace(">2<", ">3<"));
  });

  test("self-closing and missing <value>", () => {
    const src = `<root>\n  <data name="a"><value /></data>\n  <data name="b" xml:space="preserve">\n    <comment>c</comment>\n  </data>\n</root>`;
    let doc = setResxValue(parseResx(src), "a", "x");
    doc = setResxValue(doc, "b", "y");
    const out = resxToString(doc);
    expect(out).toContain(`<data name="a"><value>x</value></data>`);
    expect(out).toContain(`  <data name="b" xml:space="preserve">\n    <value>y</value>\n    <comment>c</comment>\n  </data>`);
    expect(resxValues(parseResx(out)).get("b")!.comment).toBe("c");
    // Editing again works on the rebuilt entry.
    expect(resxValues(setResxValue(doc, "a", "z")).get("a")!.value).toBe("z");
  });

  test("rejects characters XML cannot hold", () => {
    expect(codeOf(() => setResxValue(parseResx(GAME_EN), "Event", "a\u0000b"))).toBe("resx-invalid-char");
  });

  test("a new key goes after the nearest earlier key of the reference order", () => {
    const vi = emptyResxLike(parseResx(GAME_EN));
    let doc = setResxValue(vi, "Event", "Sự kiện", { order: GAME_ORDER, comment: "legacy_id=3" });
    doc = setResxValue(doc, "Gulim", "Gulim", { order: GAME_ORDER, comment: "legacy_id=0,18" });
    doc = setResxValue(doc, "Warning", "Cảnh báo", { order: GAME_ORDER, comment: "legacy_id=2" });
    expect(resxEntries(doc).map((e) => e.key)).toEqual(["Gulim", "Warning", "Event"]);
    expect(resxToString(doc)).toBe(`${GAME_EN.slice(0, GAME_EN.indexOf("  <data"))}  <data name="Gulim" xml:space="preserve">
    <value>Gulim</value>
    <comment>legacy_id=0,18</comment>
  </data>
  <data name="Warning" xml:space="preserve">
    <value>Cảnh báo</value>
    <comment>legacy_id=2</comment>
  </data>
  <data name="Event" xml:space="preserve">
    <value>Sự kiện</value>
    <comment>legacy_id=3</comment>
  </data>
</root>
`);
  });

  test("re-adding the removed entries of a file rebuilds it exactly", () => {
    for (const src of [GAME_EN, EDITOR_EN, GAME_EN.replace(/\n/g, "\r\n")]) {
      const full = parseResx(src);
      const order = resxEntries(full).map((e) => e.key);
      // Any subset, any insertion order.
      for (const removed of [order, [order[0]!], [order[order.length - 1]!], order.slice(1, 3)]) {
        let doc = full;
        for (const k of removed) doc = removeResxEntry(doc, k);
        for (const k of [...removed].reverse()) {
          const e = resxValues(full).get(k)!;
          doc = setResxValue(doc, k, e.value, { order, comment: e.comment });
        }
        expect(resxToString(doc)).toBe(src);
      }
    }
  });

  test("a key missing from the reference order goes to the end", () => {
    const out = resxToString(setResxValue(parseResx(EDITOR_EN), "New", "x"));
    expect(out.endsWith(`  </data>\n  <data name="New" xml:space="preserve">\n    <value>x</value>\n  </data>\n</root>`)).toBe(true);
  });

  test("keys with characters that need escaping in an attribute", () => {
    const doc = setResxValue(emptyResxLike(parseResx(GAME_EN)), `a"<b>&\tc`, "v");
    expect(resxToString(doc)).toContain(`<data name="a&quot;&lt;b&gt;&amp;&#x9;c" xml:space="preserve">`);
    expect(resxEntries(parseResx(resxToString(doc)))[0]!.key).toBe(`a"<b>&\tc`);
  });
});

describe("removeResxEntry / emptyResxLike", () => {
  test("removes the entry and the line in front of it", () => {
    const out = resxToString(removeResxEntry(parseResx(GAME_EN), "Warning"));
    expect(out).toBe(GAME_EN.replace(/  <data name="Warning"[\s\S]*?<\/data>\n/, ""));
  });

  test("removing an absent key returns the same document", () => {
    const doc = parseResx(GAME_EN);
    expect(removeResxEntry(doc, "nope")).toBe(doc);
  });

  test("an emptied file keeps its header and layout", () => {
    expect(resxToString(emptyResxLike(parseResx(GAME_EN)))).toBe(GAME_EN.slice(0, GAME_EN.indexOf("  <data")) + "</root>\n");
    expect(resxToString(emptyResxLike(parseResx(EDITOR_EN)))).toBe(
      EDITOR_EN.slice(0, EDITOR_EN.indexOf("  <data")).replace(/\n$/, "") + "\n</root>",
    );
  });

  test("an empty <root/> can be read and written but not added to", () => {
    const doc = parseResx("<root/>");
    expect(resxToString(doc)).toBe("<root/>");
    expect(codeOf(() => setResxValue(doc, "a", "b"))).toBe("resx-not-editable");
  });
});

describe("setResxComment", () => {
  test("changes only the comment text", () => {
    const out = resxToString(setResxComment(parseResx(GAME_EN), "Event", "legacy_id=3; keep"));
    expect(out).toBe(GAME_EN.replace("<comment>legacy_id=3</comment>", "<comment>legacy_id=3; keep</comment>"));
  });

  test("adds a comment on its own line, or inline for one-line entries", () => {
    const out = resxToString(setResxComment(parseResx(EDITOR_EN), "Save Items", "keep"));
    expect(out).toContain(`  <data name="Save Items" xml:space="preserve">\n    <value>Save Items</value>\n    <comment>keep</comment>\n  </data>`);
    const inline = `<root>\n  <data name="a"><value>x</value></data>\n</root>`;
    expect(resxToString(setResxComment(parseResx(inline), "a", "keep"))).toBe(`<root>\n  <data name="a"><value>x</value><comment>keep</comment></data>\n</root>`);
  });

  test("removing gives back the original bytes", () => {
    const doc = parseResx(EDITOR_EN);
    const added = setResxComment(doc, "Save Items", "keep");
    expect(resxToString(setResxComment(added, "Save Items", null))).toBe(EDITOR_EN);
    const game = parseResx(GAME_EN);
    const removed = resxToString(setResxComment(game, "Gulim", null));
    expect(removed).toBe(GAME_EN.replace("\n    <comment>legacy_id=0,18</comment>", ""));
    expect(resxToString(setResxComment(parseResx(removed), "Gulim", "legacy_id=0,18"))).toBe(GAME_EN);
  });

  test("value and comment edits combine; entries stay readable", () => {
    let doc = setResxValue(parseResx(GAME_EN), "Event", "Sự kiện");
    doc = setResxComment(doc, "Event", "legacy_id=3; keep");
    doc = setResxValue(doc, "Event", "Sự kiện <mới>");
    const e = resxValues(parseResx(resxToString(doc))).get("Event")!;
    expect([e.value, e.comment, e.legacyIds]).toEqual(["Sự kiện <mới>", "legacy_id=3; keep", [3]]);
    expect(resxValues(doc).get("Event")).toMatchObject({ value: "Sự kiện <mới>", comment: "legacy_id=3; keep" });
  });

  test("unknown key or same comment: same document", () => {
    const doc = parseResx(GAME_EN);
    expect(setResxComment(doc, "nope", "x")).toBe(doc);
    expect(setResxComment(doc, "Event", "legacy_id=3")).toBe(doc);
  });
});
