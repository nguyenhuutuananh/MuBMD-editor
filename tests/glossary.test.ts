import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { checkGlossary, parseDelimited, parseGlossary, parseTranslationTsv, serializeGlossary } from "../src/core";

const PARENT = path.join(import.meta.dir, "../..");

describe("parseDelimited", () => {
  test("CSV with quotes, embedded commas, escaped quotes and newlines", () => {
    expect(parseDelimited('a,b,c\n1,"x, y","say ""hi"""\n2,"multi\nline",z\n')).toEqual([
      ["a", "b", "c"],
      ["1", "x, y", 'say "hi"'],
      ["2", "multi\nline", "z"],
    ]);
  });

  test("TSV: a quote in the middle of a cell stays literal", () => {
    expect(parseDelimited('A\tB\r\nKiếm "Rồng"\t1\r\n')).toEqual([
      ["A", "B"],
      ['Kiếm "Rồng"', "1"],
    ]);
  });
});

describe("translation files as CSV", () => {
  test("MuMain_VI_Item.csv style: Nguon = reference, TiengViet = name", () => {
    const r = parseTranslationTsv("ItemType,ItemIndex,Nguon,TiengViet\n0,0,クリス,Chùy Thủy\n");
    expect(r.rows[0]).toMatchObject({ slot: 0, name: "Chùy Thủy", reference: "クリス" });
    expect(r.columns.reference).toBe(true);
  });

  test("the real MuMain_VI_Item.csv parses", () => {
    const p = path.join(PARENT, "OpenMu-vi-translation/MuMain_VI_Item.csv");
    if (!fs.existsSync(p)) return;
    const r = parseTranslationTsv(fs.readFileSync(p, "utf-8"));
    expect(r.rows.length).toBeGreaterThan(800);
    expect(r.rows[0]).toMatchObject({ slot: 0, reference: "クリス", name: "Chùy Thủy" });
  });
});

describe("parseGlossary", () => {
  test("legacy CSV: arrows, ' / ' alternatives, keep lists, skipped rows", () => {
    const g = parseGlossary(
      [
        "Loại,Thuật ngữ / Mẫu,Ghi chú",
        "Đã chốt dịch,Life / HP -> Sinh Lực,",
        "Đã chốt dịch,Defense -> Phòng Thủ,Viết tắt UI: PT",
        'Giữ nguyên - Địa danh,"Lorencia, Devias",Tên bản đồ',
        'Giữ nguyên - Mã viết tắt,"DW/SM, LV",',
        'Giữ nguyên - Placeholder,"%s, %d/%d, ...",',
        "Bỏ qua,Text lỗi encoding (mojibake Hán/Nhật),x",
      ].join("\n"),
    );
    expect(g.format).toBe("legacy-csv");
    expect(g.entries.map((e) => [e.term, e.translation])).toEqual([
      ["Life", "Sinh Lực"],
      ["HP", "Sinh Lực"],
      ["Defense", "Phòng Thủ"],
      ["Lorencia", null],
      ["Devias", null],
      ["DW/SM", null],
      ["LV", null],
    ]);
    expect(g.entries[2]!.note).toBe("Viết tắt UI: PT");
  });

  test("the real glossary files parse", () => {
    for (const f of ["OpenMu-vi-translation/MuMain_VI_Glossary.csv", "test/MuMain_VI_Glossary.csv"]) {
      const p = path.join(PARENT, f);
      if (!fs.existsSync(p)) continue;
      const g = parseGlossary(fs.readFileSync(p, "utf-8"));
      expect(g.entries.length).toBeGreaterThan(20);
      expect(g.entries.every((e) => e.term && !e.term.includes("%"))).toBe(true);
    }
  });

  test("own TSV format round-trips; empty or equal translation = keep", () => {
    const text = serializeGlossary([
      { term: "Helm", translation: "Mũ", note: "", category: "Item" },
      { term: "Zen", translation: null, note: "tiền", category: "" },
    ]);
    const g = parseGlossary(text);
    expect(g.format).toBe("tsv");
    expect(g.entries).toEqual([
      { term: "Helm", translation: "Mũ", note: "", category: "Item" },
      { term: "Zen", translation: null, note: "tiền", category: "" },
    ]);
    expect(parseGlossary("Term\tTranslation\nGuild\tGuild\n").entries[0]!.translation).toBeNull();
  });
});

describe("checkGlossary", () => {
  const g = [
    { term: "Helm", translation: "Mũ", note: "", category: "" },
    { term: "Dragon", translation: "Rồng", note: "", category: "" },
    { term: "Lorencia", translation: null, note: "", category: "" },
  ];
  const kinds = (name: string, source = "") => checkGlossary(g, name, source).map((h) => `${h.kind}:${h.term}`);

  test("source term with the agreed translation -> ok; without -> missing", () => {
    expect(kinds("Mũ Rồng Đỏ", "Red Dragon Helm")).toEqual(["ok:Helm", "ok:Dragon"]);
    expect(kinds("Nón Rồng Đỏ", "Red Dragon Helm")).toEqual(["missing:Helm", "ok:Dragon"]);
  });

  test("accent-insensitive translation check", () => {
    expect(kinds("MU RONG", "Dragon Helm")).toEqual(["ok:Helm", "ok:Dragon"]);
  });

  test("source term left untranslated in the name (no reference needed)", () => {
    expect(kinds("Đồng Helm")).toEqual(["untranslated:Helm"]);
  });

  test("keep-as-is terms", () => {
    expect(kinds("Vé Lorencia", "Lorencia Ticket")).toEqual(["ok:Lorencia"]);
    expect(kinds("Vé Thành Phố", "Lorencia Ticket")).toEqual(["keep:Lorencia"]);
  });

  test("whole words only", () => {
    expect(kinds("Helmet", "Helmets")).toEqual([]);
  });
});
