// The Session on a workspace with both sources: the Localization .resx files and the item names
// of Data/Items. Item groups are "Items.Sword"... with the item number as key.
import { describe, expect, test } from "bun:test";
import { AppError, ItemData } from "../src/core";
import { MemoryStorage } from "../src/session/memoryStorage";
import { ConflictError, Session } from "../src/session/session";
import type { RowTuple } from "../src/shared/api";
import { groupJson, sampleItems } from "./fixtures/sampleItems";
import { ITEMS_REL, sampleCheckout } from "./fixtures/sampleWorkspace";

// Sample items: English "Sword 0", "Sword 1"...; Vietnamese only for even numbers (0 "Chùy Thủy",
// 2 "Trường Kiếm"...); es / pt for numbers divisible by 3.
const ROOT = "/mu";
const SWORDS = `${ROOT}/${ITEMS_REL}/Group00_Sword.json`;
const dec = (b: Uint8Array) => new TextDecoder().decode(b);
const enc = (s: string) => new TextEncoder().encode(s);

async function opened(locale = "vi", opts: { create?: boolean; files?: Record<string, Uint8Array> } = {}) {
  let t = Date.parse("2026-09-30T10:00:00Z");
  const st = new MemoryStorage(opts.files ?? sampleCheckout(ROOT));
  const s = new Session(st, () => new Date((t += 1000)), "win32");
  await s.openFolder(ROOT, locale, null, { create: opts.create });
  return { s, st };
}
const rowOf = (s: Session, group: string, key: string) => s.rows().rows.find((r) => s.rows().groups[r[0]]!.name === group && r[1] === key);
const swordsOnDisk = (st: MemoryStorage) => ItemData.parse([{ name: "Group00_Sword.json", text: dec(st.files.get(SWORDS)!) }]);
const codes = (r: RowTuple | undefined) => r?.[5].map((i) => i[0]) ?? [];
async function codeOf(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    if (e instanceof AppError) return e.code;
    throw e;
  }
  return null;
}

describe("rows of both sources", () => {
  test("resx groups first, then one group per item file", async () => {
    const { s } = await opened();
    const { groups } = s.rows();
    expect(groups.slice(0, 4).map((g) => [g.source, g.name, g.file])).toEqual([
      ["resx", "Dialog", null],
      ["resx", "Editor", "src/Localization/Editor.vi.resx"],
      ["resx", "Game", "src/Localization/Game.vi.resx"],
      ["items", "Items.Sword", "src/bin/Data/Items/Group00_Sword.json"],
    ]);
    const sword = groups.find((g) => g.name === "Items.Sword")!;
    expect(sword.progress.total).toBe(34);
    expect(sword.progress.translated).toBe(17);
  });

  test("an item row: key = number, English = name.en, translation = name.vi", async () => {
    const { s } = await opened();
    const r0 = rowOf(s, "Items.Sword", "0")!;
    expect([r0[1], r0[2], r0[3], r0[11]]).toEqual(["0", "Sword 0", "Chùy Thủy", "translated"]);
    const r1 = rowOf(s, "Items.Sword", "1")!;
    expect([r1[2], r1[3], r1[11]]).toEqual(["Sword 1", null, "untranslated"]);
  });

  test("reference locale: another name of the same item", async () => {
    const { s } = await opened();
    await s.setReference("es");
    expect(rowOf(s, "Items.Sword", "3")![4]).toBe("Objeto 0-3");
    expect(rowOf(s, "Items.Sword", "1")![4]).toBeNull();
    expect(rowOf(s, "Game", "Event")![4]).toBeNull(); // no Game.es.resx
  });
});

describe("editing item names", () => {
  test("edit + save: only the name is rewritten, the way MuMain writes it; backup and log", async () => {
    const { s, st } = await opened();
    await s.edit("Items.Sword", "1", "Đoản Đao", "An");
    await s.edit("Game", "Event", "Sự kiện mới", "An");
    const res = await s.save();
    expect(res.files.sort()).toEqual(["src/Localization/Game.vi.resx", "src/bin/Data/Items/Group00_Sword.json"]);
    const items = sampleItems();
    items.find((i) => i.group === 0 && i.number === 1)!.names.vi = "Đoản Đao";
    expect(dec(st.files.get(SWORDS)!)).toBe(groupJson(0, items));
    expect(res.backups.some((b) => /^\/mu\/\.mumain-translator\/backups\/Group00_Sword-\d{8}-\d{6}\.json$/.test(b))).toBe(true);
    const log = dec(st.files.get(`${ROOT}/.mumain-translator/changes.tsv`)!);
    expect(log).toContain("\tAn\tsrc/bin/Data/Items/Group00_Sword.json\t1\t-\tĐoản Đao\n");
    expect(s.status().dirtyCount).toBe(0);
  });

  test("an empty name removes the translation (the game shows English)", async () => {
    const { s, st } = await opened();
    await s.edit("Items.Sword", "0", "", "An");
    expect(rowOf(s, "Items.Sword", "0")![11]).toBe("untranslated");
    await s.save();
    expect(swordsOnDisk(st).getName(0)).toBe("");
  });

  test('"||" and control characters are refused; too long / same as English are issues', async () => {
    const { s } = await opened();
    expect(await codeOf(s.edit("Items.Sword", "1", "a||b", "An"))).toBe("item-name-invalid");
    expect(await codeOf(s.edit("Items.Sword", "1", "a\u0001", "An"))).toBe("item-name-invalid");
    expect(s.status().dirtyCount).toBe(0);
    await s.edit("Items.Sword", "1", "Đ".repeat(50), "An");
    expect(codes(rowOf(s, "Items.Sword", "1"))).toEqual(["name-too-long"]);
    await s.edit("Items.Sword", "3", "Sword 3", "An");
    expect(codes(rowOf(s, "Items.Sword", "3"))).toEqual(["same-as-en"]);
  });

  test('items cannot be marked "keep"; unknown items are not editable', async () => {
    const { s } = await opened();
    expect(await codeOf(s.setKeep("Items.Sword", "1", true, "An"))).toBe("not-editable");
    expect(await codeOf(s.edit("Items.Sword", "499", "X", "An"))).toBe("not-editable");
  });

  test("undo / redo and the draft cover both sources", async () => {
    const { s, st } = await opened();
    await s.edit("Items.Sword", "1", "A", "An");
    await s.edit("Game", "Event", "B", "An");
    await s.undo();
    await s.undo();
    await s.redo();
    expect(rowOf(s, "Items.Sword", "1")![3]).toBe("A");
    await s.redo();
    const s2 = new Session(st, () => new Date(), "win32");
    await s2.openFolder(ROOT, "vi");
    expect(s2.draftInfo()?.count).toBe(2);
    const r = await s2.restoreDraft();
    expect([r.skipped, r.status.dirtyCount]).toEqual([0, 2]);
    expect(rowOf(s2, "Items.Sword", "1")![3]).toBe("A");
  });

  test("an item file changed on disk: conflict; reload keeps the edit on top", async () => {
    const { s, st } = await opened();
    await s.edit("Items.Sword", "1", "Của mình", "An");
    const theirs = swordsOnDisk(st);
    theirs.setName(3, "Của họ");
    st.files.set(SWORDS, enc(theirs.changedFiles()[0]!.text));
    const err = await s.save().catch((e) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect((err as ConflictError).files).toEqual(["src/bin/Data/Items/Group00_Sword.json"]);
    const rb = await s.rebase();
    expect(rb).toEqual({ changedFiles: ["src/bin/Data/Items/Group00_Sword.json"], conflicts: [] });
    await s.save();
    const d = swordsOnDisk(st);
    expect([d.getName(1), d.getName(3)]).toEqual(["Của mình", "Của họ"]);
  });

  test("a new locale: every item untranslated; the first name adds the key in MuMain's order", async () => {
    const { s, st } = await opened("th", { create: true });
    expect(rowOf(s, "Items.Sword", "0")![3]).toBeNull();
    await s.edit("Items.Sword", "3", "ดาบ", "An");
    await s.save();
    expect(dec(st.files.get(SWORDS)!)).toContain('"en": "Sword 3",\n        "es": "Objeto 0-3",\n        "pt": "Item 0-3",\n        "th": "ดาบ"\n');
  });
});

describe("team work across both sources", () => {
  test("TSV export / import with item rows", async () => {
    const { s, st } = await opened();
    await s.edit("Items.Sword", "1", "Đoản Đao", "An");
    await s.exportTsv(`${ROOT}/out.tsv`, [
      ["Items.Sword", "1"],
      ["Game", "Event"],
    ]);
    const tsv = dec(st.files.get(`${ROOT}/out.tsv`)!);
    expect(tsv).toContain("Items.Sword\t1\tSword 1\tĐoản Đao\ttranslated\tAn");

    const { s: other } = await opened();
    st.files.set(`${ROOT}/in.tsv`, enc(tsv));
    const other2 = new Session(st, () => new Date(), "win32");
    await other2.openFolder(ROOT, "vi");
    const p = await other2.previewImport(`${ROOT}/in.tsv`);
    expect(p.items.map((i) => [i.group, i.key, i.kind])).toEqual([["Items.Sword", "1", "apply"]]);
    void other;
  });

  test("a MuBMD-editor TSV (ItemType, ItemIndex, Name) imports into the item groups", async () => {
    const { s, st } = await opened();
    st.files.set(`${ROOT}/old.tsv`, enc(String.fromCharCode(0xfeff) + "ItemType\tItemIndex\tName\n0\t1\tĐoản Đao\n0\t0\tChùy Thủy\n7\t1\tMũ Rồng Đỏ\n15\t511\tKhông có\n"));
    const p = await s.previewImport(`${ROOT}/old.tsv`);
    expect(p.items.map((i) => [i.group, i.key, i.kind, i.english])).toEqual([
      ["Items.Sword", "1", "apply", "Sword 1"],
      ["Items.Helm", "1", "apply", "Helm 1"],
    ]);
    expect(p.counts).toMatchObject({ same: 1, unknown: 1 });
    const r = await s.applyImport(`${ROOT}/old.tsv`, p.token, [
      ["Items.Sword", "1"],
      ["Items.Helm", "1"],
    ], "An");
    expect(r.changed.length).toBe(2);
    expect(rowOf(s, "Items.Helm", "1")![3]).toBe("Mũ Rồng Đỏ");
  });

  test("an imported item name the game cannot take is invalid, never applied", async () => {
    const { s, st } = await opened();
    st.files.set(`${ROOT}/bad.tsv`, enc("Group\tKey\tTranslation\nItems.Sword\t1\ta||b\nItems.Sword\t5\t" + "Đ".repeat(50) + "\n"));
    const p = await s.previewImport(`${ROOT}/bad.tsv`);
    expect(p.items.map((i) => [i.key, i.take, i.errors.map((e) => e.code)])).toEqual([
      ["1", false, ["name-separator"]],
      ["5", false, ["name-too-long"]],
    ]);
    await s.applyImport(`${ROOT}/bad.tsv`, p.token, [["Items.Sword", "1"]], "An");
    expect(rowOf(s, "Items.Sword", "1")![3]).toBeNull();
  });

  test("status in project-vi.json; item names changed from outside reset the merge bases once", async () => {
    const { s, st } = await opened();
    await s.edit("Items.Sword", "0", "A", "An");
    await s.setStatus([["Items.Sword", "2"]], "reviewed", "An");
    await s.save();
    const project = JSON.parse(dec(st.files.get(`${ROOT}/.mumain-translator/project-vi.json`)!));
    expect(project.records["Items.Sword"]).toMatchObject({ "0": { status: "translated" }, "2": { status: "reviewed" } });
    expect(Object.keys(project.bases)).toContain("Items.Sword");

    const master = swordsOnDisk(st);
    master.setName(0, "Master");
    st.files.set(SWORDS, enc(master.changedFiles()[0]!.text));
    const s2 = new Session(st, () => new Date(), "win32");
    await s2.openFolder(ROOT, "vi");
    expect(rowOf(s2, "Items.Sword", "0")![12]?.origin).toBe("Master");
  });
});

describe("items only (a game folder)", () => {
  test("opens and saves without any .resx", async () => {
    const files = sampleCheckout("/game", { resx: false, itemsRel: "Main.app/Contents/MacOS/Data/Items" });
    const st = new MemoryStorage(files);
    const s = new Session(st, () => new Date(), "darwin");
    const info = await s.openFolder("/game", "vi");
    expect([info.folder.resx, info.folder.items?.layout]).toEqual([null, "app"]);
    expect(s.rows().groups.every((g) => g.source === "items")).toBe(true);
    await s.edit("Items.Sword", "1", "Đoản Đao", "An");
    await s.save();
    expect(st.files.has("/game/.mumain-translator/project-vi.json")).toBe(true);
    expect((await s.registration()).optionWindow).toBeNull();
  });
});
