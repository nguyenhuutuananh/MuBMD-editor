import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ItemBmd, NameValidationError, slotOf } from "../src/core";
import { NodeStorage } from "../src/server/nodeStorage";
import { ConflictError, DirtyError, Session } from "../src/session/session";
import { MAX_BACKUPS, projectPath, readDraft, workDir } from "../src/session/sidecar";
import { SAMPLE_BMD } from "./fixtures/sampleBmd";

const st = new NodeStorage();

const DATA = SAMPLE_BMD;
const ORIGINAL = new Uint8Array(fs.readFileSync(DATA));

let dir: string;
let file: string;
let clock: number;
const now = () => new Date(clock);
const tick = () => (clock += 1000);

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mubmd-session-"));
  file = path.join(dir, "Item.bmd");
  fs.writeFileSync(file, ORIGINAL);
  clock = Date.UTC(2026, 8, 28, 4, 0, 0);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

async function opened() {
  const s = new Session(st, now);
  await s.open(file);
  return s;
}
const nameOnDisk = (slot: number) => ItemBmd.parse(new Uint8Array(fs.readFileSync(file))).getName(slot).text;

describe("edit + undo/redo", () => {
  test("an edit records translator, time and original name", async () => {
    const s = await opened();
    const r = await s.edit(1, "Đoản Kiếm", "An");
    expect(r.status).toEqual({ dirtyCount: 1, canUndo: true, canRedo: false });
    expect(r.changed[0]!.item[1]).toBe("Đoản Kiếm");
    expect(r.changed[0]!.edit).toMatchObject({ slot: 1, originalText: "Đoản Đao", translator: "An" });
  });

  test("setting the same name creates no undo step", async () => {
    const s = await opened();
    expect((await s.edit(0, "Chùy Thủy", "An")).status.canUndo).toBe(false);
  });

  test("an invalid name is rejected without changing state", async () => {
    const s = await opened();
    await expect(s.edit(0, "x".repeat(60), "An")).rejects.toThrow(NameValidationError);
    expect(s.status().dirtyCount).toBe(0);
  });

  test("multi-step undo / redo", async () => {
    const s = await opened();
    await s.edit(0, "A", "An");
    await s.edit(0, "B", "Bình");
    await s.edit(1, "C", "An");
    expect((await s.undo()).changed[0]!.item[1]).toBe("Đoản Đao");
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

  test("refuses to open another file with unsaved changes unless discarding", async () => {
    const s = await opened();
    await s.edit(0, "A", "An");
    await expect(s.open(file)).rejects.toThrow(DirtyError);
    await expect(s.open(path.join(dir, "khong-co.bmd"))).rejects.toThrow(expect.objectContaining({ code: "ENOENT" }));
    await s.open(file, { discard: true });
    expect(s.status().dirtyCount).toBe(0);
    expect(await readDraft(st, file)).toBeNull();
  });
});

describe("save", () => {
  test("save: writes file, backs up the old one, logs changes, deletes draft", async () => {
    const s = await opened();
    await s.edit(slotOf(7, 1), "Mũ Rồng Lửa", "An");
    tick();
    await s.edit(0, "Chùy Nước", "Bình");
    const r = await s.save();

    expect(r.savedCount).toBe(2);
    expect(nameOnDisk(slotOf(7, 1))).toBe("Mũ Rồng Lửa");
    expect(ItemBmd.parse(new Uint8Array(fs.readFileSync(file))).checksumValid).toBe(true);
    expect(Buffer.from(fs.readFileSync(r.backupPath!)).equals(Buffer.from(ORIGINAL))).toBe(true);

    const log = fs.readFileSync(r.logPath, "utf-8").trim().split("\n");
    expect(log[0]).toBe("Time\tTranslator\tItemType\tItemIndex\tOldName\tNewName");
    expect(log).toContain("2026-09-28T04:00:01.000Z\tBình\t0\t0\tChùy Thủy\tChùy Nước");
    expect(log).toContain("2026-09-28T04:00:00.000Z\tAn\t7\t1\tMũ Rồng Đỏ\tMũ Rồng Lửa");

    expect(await readDraft(st, file)).toBeNull();
    expect(s.status().dirtyCount).toBe(0);
    expect(s.status().canUndo).toBe(true);
  });

  test("no changes -> no write, no backup", async () => {
    const r = await (await opened()).save();
    expect(r.savedCount).toBe(0);
    expect(r.backupPath).toBeNull();
    expect(fs.existsSync(workDir(file))).toBe(false);
  });

  test("undo after saving, then save again", async () => {
    const s = await opened();
    await s.edit(0, "A", "An");
    await s.save();
    await s.undo();
    expect(s.status().dirtyCount).toBe(1);
    tick();
    await s.save();
    expect(nameOnDisk(0)).toBe("Chùy Thủy");
  });

  test("detects the file changing on disk (Drive sync) and overwrites with force", async () => {
    const s = await opened();
    await s.edit(0, "A", "An");
    const other = ItemBmd.parse(ORIGINAL);
    other.setName(1, "Người khác sửa");
    fs.writeFileSync(file, other.toBytes());

    await expect(s.save()).rejects.toThrow(ConflictError);
    expect(nameOnDisk(1)).toBe("Người khác sửa");
    await s.save({ force: true });
    expect(nameOnDisk(0)).toBe("A");
  });

  test("save as another file and switch to it", async () => {
    const s = await opened();
    await s.edit(0, "A", "An");
    const dest = path.join(dir, "Item_new.bmd");
    const r = await s.save({ path: dest });
    expect(r.file.path).toBe(dest);
    expect(r.backupPath).toBeNull();
    expect(ItemBmd.parse(new Uint8Array(fs.readFileSync(dest))).getName(0).text).toBe("A");
    expect(nameOnDisk(0)).toBe("Chùy Thủy"); // original file unchanged
  });

  test(`keeps at most ${MAX_BACKUPS} backups`, async () => {
    const s = await opened();
    for (let i = 0; i < MAX_BACKUPS + 3; i++) {
      await s.edit(0, `Tên ${i}`, "An");
      tick();
      await s.save();
    }
    const backups = fs.readdirSync(path.join(workDir(file), "backups"));
    expect(backups.filter((f) => /^Item-.*\.bmd$/.test(f)).length).toBe(MAX_BACKUPS);
    expect(backups.filter((f) => /^project-.*\.json$/.test(f)).length).toBe(MAX_BACKUPS);
  });
});

describe("draft", () => {
  test("every edit writes the draft; undoing everything deletes it", async () => {
    const s = await opened();
    await s.edit(0, "A", "An");
    expect((await readDraft(st, file))?.slots).toEqual([
      { slot: 0, name: "A", record: { status: "translated", note: "", translator: "An", updatedAt: "2026-09-28T04:00:00.000Z", origin: "Chùy Thủy" } },
    ]);
    await s.undo();
    expect(await readDraft(st, file)).toBeNull();
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

  test("a draft made against a different file version (disk changed) is flagged", async () => {
    await (await opened()).edit(0, "A", "An");
    const other = ItemBmd.parse(ORIGINAL);
    other.setName(5, "Khác");
    fs.writeFileSync(file, other.toBytes());
    expect((await opened()).draftInfo()?.baseMatches).toBe(false);
  });

  test("editing without answering the draft prompt archives the old draft instead of losing it", async () => {
    await (await opened()).edit(0, "A", "An");
    const s2 = await opened();
    await s2.edit(1, "B", "Bình");
    const files = fs.readdirSync(workDir(file));
    expect(files.some((f) => /^draft-\d{8}-\d{6}\.json$/.test(f))).toBe(true);
    expect((await readDraft(st, file))?.slots.map((e) => e.slot)).toEqual([1]);
  });

  test("discard draft", async () => {
    await (await opened()).edit(0, "A", "An");
    const s2 = await opened();
    await s2.discardDraft();
    expect(await readDraft(st, file)).toBeNull();
    expect((await opened()).draftInfo()).toBeNull();
  });
});

describe("status, note and project.json", () => {
  const project = () => JSON.parse(fs.readFileSync(projectPath(st, file), "utf-8"));

  test("editing a name marks it translated and remembers the merge base", async () => {
    const s = await opened();
    await s.edit(0, "A", "An");
    expect(s.record(0)).toMatchObject({ status: "translated", translator: "An", origin: "Chùy Thủy" });
    await s.edit(0, "B", "Bình");
    expect(s.record(0).origin).toBe("Chùy Thủy"); // base stays the name before the first change
  });

  test("bulk status change is one undo step and counts as unsaved", async () => {
    const s = await opened();
    const r = await s.setStatus([0, 1, 2], "reviewed", "An");
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

  test("status-only save does not rewrite Item.bmd", async () => {
    const s = await opened();
    await s.setStatus([0], "reviewed", "An");
    const r = await s.save();
    expect(r.backupPath).toBeNull();
    expect(Buffer.from(fs.readFileSync(file)).equals(Buffer.from(ORIGINAL))).toBe(true);
  });

  test("project.json changed on disk after opening -> conflict", async () => {
    const s = await opened();
    await s.setStatus([0], "reviewed", "An");
    fs.mkdirSync(workDir(file), { recursive: true });
    fs.writeFileSync(projectPath(st, file), '{"version":1,"bmdSha1":"x","records":{}}');
    await expect(s.save()).rejects.toThrow(ConflictError);
  });

  test("Item.bmd replaced from outside since the last save -> merge bases reset once", async () => {
    const s = await opened();
    await s.edit(0, "A", "An");
    await s.save();
    // a new master copy arrives with a different name in slot 0
    const master = ItemBmd.parse(ORIGINAL);
    master.setName(0, "Master");
    fs.writeFileSync(file, master.toBytes());

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

  test("a version-1 draft (names only) is still restored", async () => {
    fs.mkdirSync(workDir(file), { recursive: true });
    fs.writeFileSync(
      path.join(workDir(file), "draft.json"),
      JSON.stringify({ version: 1, baseSha1: "", savedAt: "2026-09-28T04:00:00.000Z", edits: [{ slot: 0, name: "Cũ", translator: "An", at: "t" }] }),
    );
    const s = await opened();
    await s.restoreDraft();
    expect(s.item(0)[1]).toBe("Cũ");
    expect(s.record(0)).toMatchObject({ status: "translated", translator: "An" });
  });
});

describe("TSV export / import", () => {
  const tsvPath = () => path.join(dir, "out.tsv");

  test("export -> another copy edits -> import applies only their changes", async () => {
    // Translator copy
    const theirDir = fs.mkdtempSync(path.join(os.tmpdir(), "mubmd-their-"));
    const theirFile = path.join(theirDir, "Item.bmd");
    fs.writeFileSync(theirFile, ORIGINAL);
    const them = new Session(st, now);
    await them.open(theirFile);
    await them.edit(0, "Chùy Của Họ", "Bình"); // only they change slot 0
    await them.edit(1, "Đao Của Họ", "Bình"); // both change slot 1 -> conflict
    await them.setStatus([2], "reviewed", "Bình"); // status-only change on slot 2
    await them.exportTsv(tsvPath(), [0, 1, 2, 3]);
    fs.rmSync(theirDir, { recursive: true, force: true });

    // Master copy
    const s = await opened();
    await s.edit(1, "Đao Của Mình", "An");
    const p = await s.previewImport(tsvPath());
    expect(p.hasBase).toBe(true);
    expect(p.items.map((i) => [i.slot, i.kind, i.take])).toEqual([
      [0, "apply", true],
      [1, "conflict", false],
      [2, "status", true],
    ]);
    expect(p.items[1]).toMatchObject({ base: "Đoản Đao", ours: "Đao Của Mình", theirs: "Đao Của Họ" });
    expect(p.counts.same).toBe(1); // slot 3 unchanged on both sides

    const r = await s.applyImport(tsvPath(), p.token, [0, 2], "An");
    expect(r.changed.map((c) => c.item[0])).toEqual([0, 2]);
    expect(s.item(0)[1]).toBe("Chùy Của Họ");
    expect(s.record(0)).toMatchObject({ status: "translated", translator: "Bình", origin: "Chùy Thủy" });
    expect(s.item(1)[1]).toBe("Đao Của Mình");
    expect(s.record(2).status).toBe("reviewed");
    await s.undo(); // the whole import is one step
    expect(s.item(0)[1]).toBe("Chùy Thủy");
    expect(s.record(2).status).toBe("untranslated");
  });

  test("apply refuses if the file changed after the preview", async () => {
    const s = await opened();
    fs.writeFileSync(tsvPath(), "ItemType\tItemIndex\tName\n0\t0\tX\n");
    const p = await s.previewImport(tsvPath());
    fs.writeFileSync(tsvPath(), "ItemType\tItemIndex\tName\n0\t0\tY\n");
    await expect(s.applyImport(tsvPath(), p.token, [0], "An")).rejects.toThrow(expect.objectContaining({ code: "import-changed" }));
  });

  test("the old items.tsv (no BaseName) imports as plain changes", async () => {
    const s = await opened();
    fs.writeFileSync(tsvPath(), "ItemType\tItemIndex\tName\n0\t0\tChùy Thủy\n0\t1\tĐoản Đao Mới\n");
    const p = await s.previewImport(tsvPath());
    expect(p.hasBase).toBe(false);
    expect(p.items.map((i) => [i.slot, i.kind, i.base])).toEqual([[1, "apply", null]]);
  });

  test("export includes status, base, note and reference names", async () => {
    const s = await opened();
    const ref = path.join(dir, "ref.tsv");
    fs.writeFileSync(ref, "ItemType\tItemIndex\tName(Japanese)\n0\t0\tクリス\n");
    expect((await s.setReference(ref))?.entries).toEqual([[0, "クリス"]]);
    await s.edit(0, "Chùy Mới", "An");
    await s.setNote(0, "ok", "An");
    await s.exportTsv(tsvPath(), [0]);
    const text = fs.readFileSync(tsvPath(), "utf-8");
    expect(text.startsWith("\uFEFF")).toBe(true);
    expect(text.split("\n")[1]).toBe("0\t0\tChùy Mới\ttranslated\tAn\t2026-09-28T04:00:00.000Z\tChùy Thủy\tクリス\tok");
  });

  test("an Item.bmd can be used as reference", async () => {
    const s = await opened();
    expect((await s.setReference(DATA))?.entries.length).toBe(488);
    expect(await s.setReference(null)).toBeNull();
  });

  test("compare with another Item.bmd: differing names are listed as changes", async () => {
    const s = await opened();
    const other = ItemBmd.parse(ORIGINAL);
    other.setName(0, "Chùy Khác");
    other.setName(9, "");
    const otherFile = path.join(dir, "Other.bmd");
    fs.writeFileSync(otherFile, other.toBytes());
    const p = await s.previewImport(otherFile);
    expect(p.source).toBe("bmd");
    expect(p.hasBase).toBe(false);
    expect(p.items.map((i) => [i.slot, i.kind, i.theirs])).toEqual([[0, "apply", "Chùy Khác"]]);
    await s.applyImport(otherFile, p.token, [0], "An");
    expect(s.item(0)[1]).toBe("Chùy Khác");
    expect(s.item(9)[1]).toBe("Kiếm Rồng Lửa"); // an empty name over there never clears ours
  });

  test("a CSV reference with a source column (MuMain_VI_Item.csv style) shows the source", async () => {
    const s = await opened();
    const ref = path.join(dir, "ref.csv");
    fs.writeFileSync(ref, "ItemType,ItemIndex,Nguon,TiengViet\n0,0,クリス,Chùy Thủy\n");
    expect((await s.setReference(ref))?.entries).toEqual([[0, "クリス"]]);
  });
});

