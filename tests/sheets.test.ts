// Google Sheets layout: one CSV per tab (Key, English, Vietnamese / ItemType, ItemIndex, ...),
// exported as a ZIP and imported back (one tab, or the ZIP) with the 3-way merge.
import { describe, expect, test } from "bun:test";
import { languageName, parseDelimited, sheetFileName, sheetTab, unzip, zip } from "../src/core";
import { MemoryStorage } from "../src/session/memoryStorage";
import { Session } from "../src/session/session";
import { sampleCheckout } from "./fixtures/sampleWorkspace";

const ROOT = "/mu";
const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

async function checkout() {
  const st = new MemoryStorage(sampleCheckout(ROOT));
  const s = new Session(st, undefined, "win32");
  await s.openFolder(ROOT, "vi");
  return { s, st };
}
const valueOf = (s: Session, group: string, key: string) => s.rows().rows.find((r) => s.rows().groups[r[0]]!.name === group && r[1] === key)![3];

describe("names", () => {
  test("tab of a file name", () => {
    expect(sheetTab("MuMain_VI_Game.csv")).toBe("Game");
    expect(sheetTab("MuMain_VI - Game.csv")).toBe("Game"); // Google Sheets: "<spreadsheet> - <tab>.csv"
    expect(sheetTab("/x/Dịch MU - Dialog.tsv")).toBe("Dialog");
    expect(sheetTab("MuMain_ZH_TW_Item.csv")).toBe("Item");
    expect(sheetTab("Editor.csv")).toBe("Editor");
    expect(sheetFileName("vi", "Game")).toBe("MuMain_VI_Game.csv");
    expect(languageName("vi")).toBe("Vietnamese");
  });
});

describe("export", () => {
  test("a CSV per string table and one for the item names, with Status / Note / BaseText", async () => {
    const { s, st } = await checkout();
    await s.edit("Game", "Chaos Castle", "Lâu Đài Hỗn Loạn", "An"); // unsaved edits are included
    const res = await s.exportSheets("/out/sheets.zip");
    const files = unzip(st.files.get("/out/sheets.zip")!);
    expect(files.map((f) => f.name)).toEqual(["MuMain_VI_Dialog.csv", "MuMain_VI_Editor.csv", "MuMain_VI_Game.csv", "MuMain_VI_Item.csv"]);
    expect(res.tabs).toBe(4);
    const game = parseDelimited(dec(files[2]!.bytes));
    expect(game[0]).toEqual(["Key", "English", "Vietnamese", "Status", "Note", "BaseText"]);
    // BaseText = the text as exported (the sheet is a copy taken now).
    expect(game.find((r) => r[0] === "Chaos Castle")).toEqual(["Chaos Castle", "Chaos Castle", "Lâu Đài Hỗn Loạn", "translated", "", "Lâu Đài Hỗn Loạn"]);
    expect(game.find((r) => r[0] === "Event")).toEqual(["Event", "Event", "Sự kiện", "translated", "", "Sự kiện"]);
    const items = parseDelimited(dec(files[3]!.bytes));
    expect(items[0]).toEqual(["ItemType", "ItemIndex", "English", "Vietnamese", "Status", "Note", "BaseText"]);
    expect(items[1]).toEqual(["0", "0", "Sword 0", "Chùy Thủy", "translated", "", "Chùy Thủy"]);
  });
});

describe("import", () => {
  test("round trip: what was changed in the sheet applies, what both changed is a conflict", async () => {
    const { s, st } = await checkout();
    await s.edit("Game", "Level %d", "Cấp %d", "An"); // translated here before the export: not a conflict when edited in the sheet
    await s.save();
    await s.exportSheets("/out/sheets.zip");
    // In the sheet: two texts changed. Here: one of them changed too, after the export.
    const files = unzip(st.files.get("/out/sheets.zip")!).map((f) => {
      let text = dec(f.bytes);
      if (f.name.endsWith("Game.csv")) text = text.replace("Event,Event,Sự kiện,", "Event,Event,Sự Kiện (sheet),").replace("Chaos Castle,Chaos Castle,,", "Chaos Castle,Chaos Castle,Lâu Đài Hỗn Loạn,");
      if (f.name.endsWith("Item.csv")) text = text.replace("0,1,Sword 1,,", "0,1,Sword 1,Đoản Kiếm,");
      if (f.name.endsWith("Game.csv")) text = text.replace("Level %d,Level %d,Cấp %d,", "Level %d,Level %d,Cấp độ %d,");
      return { name: f.name, bytes: enc(text) };
    });
    await s.edit("Game", "Event", "Sự Kiện (ở đây)", "An");
    st.files.set("/in/sheets.zip", zip(files));
    const p = await s.previewImport("/in/sheets.zip");
    expect(p.hasBase).toBe(true);
    expect(p.items.map((i) => [i.group, i.key, i.kind, i.take]).sort()).toEqual([
      ["Game", "Chaos Castle", "apply", true],
      ["Game", "Event", "conflict", false],
      ["Game", "Level %d", "apply", true],
      ["Items.Sword", "1", "apply", true],
    ]);
    await s.applyImport("/in/sheets.zip", p.token, [["Game", "Chaos Castle"], ["Items.Sword", "1"]], "An");
    expect([valueOf(s, "Game", "Chaos Castle"), valueOf(s, "Items.Sword", "1"), valueOf(s, "Game", "Event")]).toEqual(["Lâu Đài Hỗn Loạn", "Đoản Kiếm", "Sự Kiện (ở đây)"]);
  });

  test("one tab downloaded from the team's current sheet (Key, English, Vietnamese; no BaseText)", async () => {
    const { s, st } = await checkout();
    st.files.set("/in/MuMain_VI - Game.csv", enc("Key,English,Vietnamese\nChaos Castle,Chaos Castle,Lâu Đài Hỗn Loạn\nEvent,Event,Sự kiện\nGone,Gone,Mất\n"));
    const p = await s.previewImport("/in/MuMain_VI - Game.csv");
    expect(p.hasBase).toBe(false);
    expect(p.items.map((i) => [i.key, i.kind])).toEqual([["Chaos Castle", "apply"]]);
    expect([p.counts.same, p.counts.unknown]).toEqual([1, 1]);
  });

  test("the old Item tab (Nguon = Japanese, TiengViet) is not taken for outdated English", async () => {
    const { s, st } = await checkout();
    st.files.set("/in/MuMain_VI_Item.csv", enc("ItemType,ItemIndex,Nguon,TiengViet\n0,1,ダガー,Đoản Đao\n"));
    const p = await s.previewImport("/in/MuMain_VI_Item.csv");
    expect(p.items.map((i) => [i.group, i.key, i.kind, i.take, i.theirEnglish])).toEqual([["Items.Sword", "1", "apply", true, undefined]]);
  });

  test("keys written as ResxGen's C++ name are matched", async () => {
    const { s, st } = await checkout();
    st.files.set("/in/MuMain_VI_Game.csv", enc("Key,English,Vietnamese\nLevelD,Level %d,Cấp %d\n"));
    const p = await s.previewImport("/in/MuMain_VI_Game.csv");
    expect(p.items.map((i) => [i.key, i.theirs])).toEqual([["Level %d", "Cấp %d"]]);
  });

  test("a tab whose name is no group", async () => {
    const { s, st } = await checkout();
    st.files.set("/in/Sheet1.csv", enc("Key,English,Vietnamese\nEvent,Event,Sự kiện\n"));
    await expect(s.previewImport("/in/Sheet1.csv")).rejects.toMatchObject({ code: "sheet-tab", params: { tab: "Sheet1" } });
  });
});
