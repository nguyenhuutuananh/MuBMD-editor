import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ItemData, NameValidationError, NoItemError, slotOf } from "../src/core";
import { NodeStorage } from "../src/server/nodeStorage";
import { ConflictError, DirtyError, Session } from "../src/session/session";
import { MAX_BACKUPS, projectPath, readDraft, workDir } from "../src/session/sidecar";
import { sampleFiles } from "./fixtures/sampleItems";

const st = new NodeStorage();
const FILES = sampleFiles();
const SWORDS = "Group00_Sword.json";

// On disk (see fixtures/sampleItems.ts): slot 0 "Chùy Thủy", 2 "Trường Kiếm", 4 "Đao Sát Thủ" ...
// (even indexes); odd indexes have no Vietnamese name. English names: "Sword 0", "Sword 1" ...

let dir: string; // the game folder
let items: string; // <game>/Data/Items
let clock: number;
const now = () => new Date(clock);
const tick = () => (clock += 1000);

function writeGame(root: string, files = FILES) {
  const d = path.join(root, "Data", "Items");
  fs.mkdirSync(d, { recursive: true });
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(d, name), text);
  return d;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mubmd-session-"));
  items = writeGame(dir);
  clock = Date.UTC(2026, 8, 28, 4, 0, 0);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

async function opened() {
  const s = new Session(st, now);
  await s.open(dir);
  return s;
}
const disk = () =>
  ItemData.parse(fs.readdirSync(items).filter((n) => n.endsWith(".json")).map((name) => ({ name, text: fs.readFileSync(path.join(items, name), "utf-8") })));
const nameOnDisk = (slot: number) => disk().getName(slot);
// Change a name on disk from outside (another program / a sync).
function changeOnDisk(slot: number, name: string) {
  const d = disk();
  d.setName(slot, name);
  for (const f of d.changedFiles()) fs.writeFileSync(path.join(items, f.name), f.text);
}

describe("open", () => {
  test("finds Data/Items in the game folder and describes it", async () => {
    const s = await opened();
    expect(s.file).toMatchObject({ path: items, root: dir, layout: "game", fileName: "Data/Items", locale: "vi", fileCount: 14 });
    expect(s.file!.translatedCount).toBeGreaterThan(200);
    expect(s.item(0)).toEqual([0, "Chùy Thủy", "Sword 0", 9, []]);
    expect(s.item(1)).toEqual([1, "", "Sword 1", 0, []]);
    expect(s.item(slotOf(15, 511))[2]).toBeNull();
  });

  test("a folder without item data is refused", async () => {
    const s = new Session(st, now);
    await expect(s.open(path.join(dir, "Data", "Items", "Group00_Sword.json", ".."))).resolves.toBeTruthy(); // Items itself works
    await expect(new Session(st, now).open(os.tmpdir())).rejects.toThrow(expect.objectContaining({ code: "items-not-found" }));
  });

  test("a broken item file is reported with its name", async () => {
    fs.writeFileSync(path.join(items, SWORDS), '{"group":0,"items":[');
    await expect(new Session(st, now).open(dir)).rejects.toThrow(expect.objectContaining({ code: "item-json", params: expect.objectContaining({ file: SWORDS }) }));
  });
});

describe("edit + undo/redo", () => {
  test("an edit records translator, time and original name", async () => {
    const s = await opened();
    const r = await s.edit(1, "Đoản Kiếm", "An");
    expect(r.status).toEqual({ dirtyCount: 1, canUndo: true, canRedo: false });
    expect(r.changed[0]!.item[1]).toBe("Đoản Kiếm");
    expect(r.changed[0]!.edit).toMatchObject({ slot: 1, originalText: "", translator: "An" });
    expect(r.changed[0]!.record.status).toBe("translated");
  });

  test("setting the same name creates no undo step", async () => {
    const s = await opened();
    expect((await s.edit(0, "Chùy Thủy", "An")).status.canUndo).toBe(false);
  });

  test("invalid names and slots without an item are rejected without changing state", async () => {
    const s = await opened();
    await expect(s.edit(0, "x".repeat(60), "An")).rejects.toThrow(NameValidationError);
    await expect(s.edit(slotOf(15, 511), "A", "An")).rejects.toThrow(NoItemError);
    await expect(s.setNote(slotOf(15, 511), "A", "An")).rejects.toThrow(NoItemError);
    expect(s.status().dirtyCount).toBe(0);
  });

  test("an empty name removes the translation", async () => {
    const s = await opened();
    const r = await s.edit(0, "", "An");
    expect(r.changed[0]!.item[1]).toBe("");
    expect(r.changed[0]!.record.status).toBe("untranslated");
    await s.save();
    expect(nameOnDisk(0)).toBe("");
    expect(fs.readFileSync(path.join(items, SWORDS), "utf-8")).toContain('"name": {\n        "en": "Sword 0",\n        "es": "Objeto 0-0",\n        "pt": "Item 0-0"\n      },');
  });

  test("multi-step undo / redo", async () => {
    const s = await opened();
    await s.edit(0, "A", "An");
    await s.edit(0, "B", "Bình");
    await s.edit(1, "C", "An");
    expect((await s.undo()).changed[0]!.item[1]).toBe("");
    expect((await s.undo()).changed[0]!.edit).toMatchObject({ translator: "An" }); // back to An's "A"
    expect(s.item(0)[1]).toBe("A");
    const back = await s.undo();
    expect(back.changed[0]!.edit).toBeNull();
    expect(back.status).toEqual({ dirtyCount: 0, canUndo: false, canRedo: true });
    await s.redo();
    await s.redo();
    expect(s.item(0)[1]).toBe("B");
    expect(s.editInfo(0)?.translator).toBe("Bình");
  });

  test("undo restores an over-long name read from the files", async () => {
    changeOnDisk(0, "x".repeat(49));
    const long = fs.readFileSync(path.join(items, SWORDS), "utf-8").replace("x".repeat(49), "y".repeat(60));
    fs.writeFileSync(path.join(items, SWORDS), long);
    const s = await opened();
    expect(s.item(0)[4]).toEqual(["too-long"]);
    await s.edit(0, "Ngắn", "An");
    await s.undo();
    expect(s.item(0)[1]).toBe("y".repeat(60));
    expect(s.status().dirtyCount).toBe(0);
  });

  test("a new edit clears the redo branch", async () => {
    const s = await opened();
    await s.edit(0, "A", "An");
    await s.undo();
    expect((await s.edit(1, "B", "An")).status.canRedo).toBe(false);
  });

  test("reverting to the original name is an undoable step", async () => {
    const s = await opened();
    await s.edit(0, "A", "An");
    expect((await s.revert(0, "An")).status.dirtyCount).toBe(0);
    await s.undo();
    expect(s.item(0)[1]).toBe("A");
  });

  test("refuses to open another folder with unsaved changes unless discarding", async () => {
    const s = await opened();
    await s.edit(0, "A", "An");
    await expect(s.open(dir)).rejects.toThrow(DirtyError);
    await expect(s.open(path.join(dir, "khong-co"))).rejects.toThrow(expect.objectContaining({ code: "items-not-found" }));
    await s.open(dir, { discard: true });
    expect(s.status().dirtyCount).toBe(0);
    expect(await readDraft(st, items)).toBeNull();
  });
});

describe("save", () => {
  test("save: rewrites only the changed files, backs them up, logs changes, deletes draft", async () => {
    const s = await opened();
    await s.edit(slotOf(7, 1), "Mũ Rồng Lửa", "An");
    tick();
    await s.edit(0, "Chùy Nước", "Bình");
    const helmsBefore = fs.readFileSync(path.join(items, "Group07_Helm.json"), "utf-8");
    const axes = fs.statSync(path.join(items, "Group01_Axe.json")).mtimeMs;
    const r = await s.save();

    expect(r.savedCount).toBe(2);
    expect(r.written.map((p) => path.basename(p))).toEqual([SWORDS, "Group07_Helm.json"]);
    expect(nameOnDisk(slotOf(7, 1))).toBe("Mũ Rồng Lửa");
    expect(nameOnDisk(0)).toBe("Chùy Nước");
    expect(fs.statSync(path.join(items, "Group01_Axe.json")).mtimeMs).toBe(axes);
    expect(r.backupDir).toBe(path.join(workDir(items), "backups"));
    const backups = fs.readdirSync(r.backupDir!);
    const helmBackup = backups.find((f) => /^Group07_Helm-\d{8}-\d{6}\.json$/.test(f))!;
    expect(fs.readFileSync(path.join(r.backupDir!, helmBackup), "utf-8")).toBe(helmsBefore);
    expect(workDir(items)).toBe(path.join(dir, "Data", "Items.mubmd")); // outside Data/Items

    const log = fs.readFileSync(r.logPath, "utf-8").trim().split("\n");
    expect(log[0]).toBe("Time\tTranslator\tItemType\tItemIndex\tOldName\tNewName");
    expect(log).toContain("2026-09-28T04:00:01.000Z\tBình\t0\t0\tChùy Thủy\tChùy Nước");
    expect(log).toContain("2026-09-28T04:00:00.000Z\tAn\t7\t1\t\tMũ Rồng Lửa");

    expect(await readDraft(st, items)).toBeNull();
    expect(s.status().dirtyCount).toBe(0);
    expect(s.status().canUndo).toBe(true);
  });

  test("no changes -> no write, no backup", async () => {
    const r = await (await opened()).save();
    expect(r.savedCount).toBe(0);
    expect(r.backupDir).toBeNull();
    expect(fs.existsSync(workDir(items))).toBe(false);
  });

  test("undo after saving, then save again restores the original file exactly", async () => {
    const s = await opened();
    await s.edit(1, "A", "An");
    await s.save();
    await s.undo();
    expect(s.status().dirtyCount).toBe(1);
    tick();
    await s.save();
    expect(fs.readFileSync(path.join(items, SWORDS), "utf-8")).toBe(FILES[SWORDS]!);
  });

  test("detects an item file changing on disk (Drive sync) and overwrites with force", async () => {
    const s = await opened();
    await s.edit(0, "A", "An");
    changeOnDisk(1, "Người khác sửa");

    await expect(s.save()).rejects.toThrow(ConflictError);
    expect(nameOnDisk(1)).toBe("Người khác sửa");
    await s.save({ force: true });
    expect(nameOnDisk(0)).toBe("A");
  });

  test("a change on disk in a file this save does not touch is no conflict", async () => {
    const s = await opened();
    await s.edit(0, "A", "An");
    changeOnDisk(slotOf(7, 1), "Khác");
    await s.save();
    expect(nameOnDisk(0)).toBe("A");
    expect(nameOnDisk(slotOf(7, 1))).toBe("Khác");
  });

  test(`keeps at most ${MAX_BACKUPS} backups per file`, async () => {
    const s = await opened();
    for (let i = 0; i < MAX_BACKUPS + 3; i++) {
      await s.edit(0, `Tên ${i}`, "An");
      tick();
      await s.save();
    }
    const backups = fs.readdirSync(path.join(workDir(items), "backups"));
    expect(backups.filter((f) => /^Group00_Sword-.*\.json$/.test(f)).length).toBe(MAX_BACKUPS);
    expect(backups.filter((f) => /^project-.*\.json$/.test(f)).length).toBe(MAX_BACKUPS);
  });
});

describe("draft", () => {
  test("every edit writes the draft; undoing everything deletes it", async () => {
    const s = await opened();
    await s.edit(0, "A", "An");
    expect((await readDraft(st, items))?.slots).toEqual([
      { slot: 0, name: "A", record: { status: "translated", note: "", translator: "An", updatedAt: "2026-09-28T04:00:00.000Z", origin: "Chùy Thủy" } },
    ]);
    await s.undo();
    expect(await readDraft(st, items)).toBeNull();
  });

  test("reopening after a crash restores the draft as one undo step", async () => {
    const s1 = await opened();
    await s1.edit(0, "A", "An");
    await s1.edit(1, "B", "Bình");

    const s2 = await opened();
    expect(s2.draftInfo()).toMatchObject({ count: 2, translators: ["An", "Bình"], baseMatches: true });
    const r = await s2.restoreDraft();
    expect(r.skipped).toBe(0);
    expect(r.status.dirtyCount).toBe(2);
    expect(s2.editInfo(1)?.translator).toBe("Bình");
    expect(s2.draftInfo()).toBeNull();
    await s2.undo();
    expect(s2.status().dirtyCount).toBe(0);
  });

  test("a draft made against different names on disk is flagged", async () => {
    await (await opened()).edit(0, "A", "An");
    changeOnDisk(5, "Khác");
    expect((await opened()).draftInfo()?.baseMatches).toBe(false);
  });

  test("editing without answering the draft prompt archives the old draft instead of losing it", async () => {
    await (await opened()).edit(0, "A", "An");
    const s2 = await opened();
    await s2.edit(1, "B", "Bình");
    const files = fs.readdirSync(workDir(items));
    expect(files.some((f) => /^draft-\d{8}-\d{6}\.json$/.test(f))).toBe(true);
    expect((await readDraft(st, items))?.slots.map((e) => e.slot)).toEqual([1]);
  });

  test("discard draft", async () => {
    await (await opened()).edit(0, "A", "An");
    const s2 = await opened();
    await s2.discardDraft();
    expect(await readDraft(st, items)).toBeNull();
    expect((await opened()).draftInfo()).toBeNull();
  });
});

describe("status, note and project.json", () => {
  const project = () => JSON.parse(fs.readFileSync(projectPath(st, items), "utf-8"));

  test("editing a name marks it translated and remembers the merge base", async () => {
    const s = await opened();
    await s.edit(0, "A", "An");
    expect(s.record(0)).toMatchObject({ status: "translated", translator: "An", origin: "Chùy Thủy" });
    await s.edit(0, "B", "Bình");
    expect(s.record(0).origin).toBe("Chùy Thủy"); // base stays the name before the first change
  });

  test("bulk status change is one undo step, counts as unsaved and skips slots without an item", async () => {
    const s = await opened();
    const r = await s.setStatus([0, 1, 2, slotOf(15, 511)], "reviewed", "An");
    expect(r.changed.map((c) => [c.item[0], c.record.status, c.dirty])).toEqual([
      [0, "reviewed", true],
      [1, "reviewed", true],
      [2, "reviewed", true],
    ]);
    expect(r.status.dirtyCount).toBe(3);
    await s.undo();
    expect(s.status().dirtyCount).toBe(0);
  });

  test("setting the saved status / note back makes the slot clean again", async () => {
    const s = await opened();
    await s.setStatus([0], "reviewed", "An");
    await s.setStatus([0], "untranslated", "An");
    expect(s.status().dirtyCount).toBe(0);
    await s.setNote(0, "check\twith team", "An");
    expect(s.record(0).note).toBe("check with team");
    await s.setNote(0, "", "An");
    expect(s.status().dirtyCount).toBe(0);
  });

  test("typing the original name again restores the saved record", async () => {
    const s = await opened();
    await s.edit(0, "A", "An");
    await s.edit(0, "Chùy Thủy", "An");
    expect(s.status().dirtyCount).toBe(0);
    expect(s.record(0).status).toBe("untranslated");
  });

  test("save writes project.json; reopening restores statuses", async () => {
    const s = await opened();
    await s.edit(0, "A", "An");
    await s.setStatus([1], "reviewed", "Bình");
    await s.setNote(2, "ghi chú", "Bình");
    expect((await s.save()).savedCount).toBe(3);
    expect(project().records).toMatchObject({ 0: { status: "translated" }, 1: { status: "reviewed" }, 2: { note: "ghi chú" } });

    const s2 = await opened();
    expect(s2.wasRebased()).toBe(false);
    expect(s2.record(1)).toMatchObject({ status: "reviewed", translator: "Bình" });
    expect(s2.status().dirtyCount).toBe(0);
  });

  test("status-only save does not rewrite any item file", async () => {
    const s = await opened();
    await s.setStatus([0], "reviewed", "An");
    const r = await s.save();
    expect(r.written).toEqual([]);
    expect(r.backupDir).toBeNull();
    expect(fs.readFileSync(path.join(items, SWORDS), "utf-8")).toBe(FILES[SWORDS]!);
  });

  test("project.json changed on disk after opening -> conflict", async () => {
    const s = await opened();
    await s.setStatus([0], "reviewed", "An");
    fs.mkdirSync(workDir(items), { recursive: true });
    fs.writeFileSync(projectPath(st, items), '{"version":2,"namesSha1":"x","records":{}}');
    await expect(s.save()).rejects.toThrow(ConflictError);
  });

  test("names changed from outside since the last save -> merge bases reset once", async () => {
    const s = await opened();
    await s.edit(0, "A", "An");
    await s.save();
    changeOnDisk(0, "Master"); // a new master copy arrives with a different name in slot 0

    const s2 = await opened();
    expect(s2.wasRebased()).toBe(true);
    expect(s2.record(0).origin).toBe("Master");
    expect((await opened()).wasRebased()).toBe(false); // persisted: reported only once
  });

  test("draft keeps status-only changes too", async () => {
    await (await opened()).setStatus([5], "reviewed", "An");
    const s2 = await opened();
    expect(s2.draftInfo()?.count).toBe(1);
    await s2.restoreDraft();
    expect(s2.record(5).status).toBe("reviewed");
  });
});

describe("TSV export / import, compare", () => {
  const tsvPath = () => path.join(dir, "out.tsv");

  test("export -> another copy edits -> import applies only their changes", async () => {
    // Translator copy
    const theirDir = fs.mkdtempSync(path.join(os.tmpdir(), "mubmd-their-"));
    writeGame(theirDir);
    const them = new Session(st, now);
    await them.open(theirDir);
    await them.edit(0, "Chùy Của Họ", "Bình"); // only they change slot 0
    await them.edit(2, "Kiếm Của Họ", "Bình"); // both change slot 2 -> conflict
    await them.setStatus([4], "reviewed", "Bình"); // status-only change on slot 4
    await them.exportTsv(tsvPath(), [0, 2, 4, 6]);
    fs.rmSync(theirDir, { recursive: true, force: true });

    // Master copy
    const s = await opened();
    await s.edit(2, "Kiếm Của Mình", "An");
    const p = await s.previewImport(tsvPath());
    expect(p.hasBase).toBe(true);
    expect(p.items.map((i) => [i.slot, i.kind, i.take])).toEqual([
      [0, "apply", true],
      [2, "conflict", false],
      [4, "status", true],
    ]);
    expect(p.items[1]).toMatchObject({ base: "Trường Kiếm", ours: "Kiếm Của Mình", theirs: "Kiếm Của Họ" });
    expect(p.counts.same).toBe(1); // slot 6 unchanged on both sides

    const r = await s.applyImport(tsvPath(), p.token, [0, 4], "An");
    expect(r.changed.map((c) => c.item[0])).toEqual([0, 4]);
    expect(s.item(0)[1]).toBe("Chùy Của Họ");
    expect(s.record(0)).toMatchObject({ status: "translated", translator: "Bình", origin: "Chùy Thủy" });
    expect(s.item(2)[1]).toBe("Kiếm Của Mình");
    expect(s.record(4).status).toBe("reviewed");
    await s.undo(); // the whole import is one step
    expect(s.item(0)[1]).toBe("Chùy Thủy");
    expect(s.record(4).status).toBe("untranslated");
  });

  test("apply refuses if the file changed after the preview", async () => {
    const s = await opened();
    fs.writeFileSync(tsvPath(), "ItemType\tItemIndex\tName\n0\t0\tX\n");
    const p = await s.previewImport(tsvPath());
    fs.writeFileSync(tsvPath(), "ItemType\tItemIndex\tName\n0\t0\tY\n");
    await expect(s.applyImport(tsvPath(), p.token, [0], "An")).rejects.toThrow(expect.objectContaining({ code: "import-changed" }));
  });

  test("a plain name list (no BaseName) imports as changes; slots without an item are skipped", async () => {
    const s = await opened();
    fs.writeFileSync(tsvPath(), "ItemType\tItemIndex\tName\n0\t0\tChùy Thủy\n0\t1\tĐoản Đao\n15\t511\tKhông có\n");
    const p = await s.previewImport(tsvPath());
    expect(p.hasBase).toBe(false);
    expect(p.items.map((i) => [i.slot, i.kind, i.base, i.ours])).toEqual([[1, "apply", null, ""]]);
    expect(p.counts.noItem).toBe(1);
  });

  test("export includes status, base, note, and the English name as reference", async () => {
    const s = await opened();
    await s.edit(0, "Chùy Mới", "An");
    await s.setNote(0, "ok", "An");
    await s.exportTsv(tsvPath(), [0, 1, slotOf(15, 511)]);
    const lines = fs.readFileSync(tsvPath(), "utf-8").split("\n");
    expect(lines[0]!.charCodeAt(0)).toBe(0xfeff);
    expect(lines[1]).toBe("0\t0\tChùy Mới\ttranslated\tAn\t2026-09-28T04:00:00.000Z\tChùy Thủy\tSword 0\tok");
    expect(lines[2]).toBe("0\t1\t\tuntranslated\t\t\t\tSword 1\t");
    expect(lines.filter(Boolean).length).toBe(3); // no row for a slot without an item
  });

  test("a reference file replaces the English names in the export", async () => {
    const s = await opened();
    const ref = path.join(dir, "ref.tsv");
    fs.writeFileSync(ref, "ItemType\tItemIndex\tName(Japanese)\n0\t0\tクリス\n");
    expect((await s.setReference(ref))?.entries).toEqual([[0, "クリス"]]);
    await s.exportTsv(tsvPath(), [0]);
    expect(fs.readFileSync(tsvPath(), "utf-8").split("\n")[1]).toContain("\tクリス\t");
    expect(await s.setReference(null)).toBeNull();
  });

  test("compare with another game folder: differing names are listed as changes", async () => {
    const s = await opened();
    const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), "mubmd-other-"));
    writeGame(otherDir);
    const other = new Session(st, now);
    await other.open(otherDir);
    await other.edit(0, "Chùy Khác", "Bình");
    await other.edit(4, "", "Bình");
    await other.save();

    const p = await s.previewImport(otherDir, "game");
    expect(p.source).toBe("game");
    expect(p.hasBase).toBe(false);
    expect(p.items.map((i) => [i.slot, i.kind, i.theirs])).toEqual([[0, "apply", "Chùy Khác"]]);
    await s.applyImport(otherDir, p.token, [0], "An", "game");
    expect(s.item(0)[1]).toBe("Chùy Khác");
    expect(s.item(4)[1]).toBe("Đao Sát Thủ"); // a missing name over there never clears ours
    fs.rmSync(otherDir, { recursive: true, force: true });
  });

  test("a CSV reference with a source column (MuMain_VI_Item.csv style) shows the source", async () => {
    const s = await opened();
    const ref = path.join(dir, "ref.csv");
    fs.writeFileSync(ref, "ItemType,ItemIndex,Nguon,TiengViet\n0,0,クリス,Chùy Thủy\n");
    expect((await s.setReference(ref))?.entries).toEqual([[0, "クリス"]]);
  });
});
