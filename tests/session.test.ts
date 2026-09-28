import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ItemBmd, NameValidationError, slotOf } from "../src/core";
import { ConflictError, DirtyError, Session } from "../src/server/session";
import { MAX_BACKUPS, projectPath, readDraft, workDir } from "../src/server/storage";

const DATA = path.join(import.meta.dir, "../data/Item.bmd");
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

function opened() {
  const s = new Session(now);
  s.open(file);
  return s;
}
const nameOnDisk = (slot: number) => ItemBmd.parse(new Uint8Array(fs.readFileSync(file))).getName(slot).text;

describe("edit + undo/redo", () => {
  test("an edit records translator, time and original name", () => {
    const s = opened();
    const r = s.edit(1, "Đoản Kiếm", "An");
    expect(r.status).toEqual({ dirtyCount: 1, canUndo: true, canRedo: false });
    expect(r.changed[0]!.item[1]).toBe("Đoản Kiếm");
    expect(r.changed[0]!.edit).toMatchObject({ slot: 1, originalText: "Đoản Đao", translator: "An" });
  });

  test("setting the same name creates no undo step", () => {
    const s = opened();
    expect(s.edit(0, "Chùy Thủy", "An").status.canUndo).toBe(false);
  });

  test("an invalid name is rejected without changing state", () => {
    const s = opened();
    expect(() => s.edit(0, "x".repeat(60), "An")).toThrow(NameValidationError);
    expect(s.status().dirtyCount).toBe(0);
  });

  test("multi-step undo / redo", () => {
    const s = opened();
    s.edit(0, "A", "An");
    s.edit(0, "B", "Bình");
    s.edit(1, "C", "An");
    expect(s.undo().changed[0]!.item[1]).toBe("Đoản Đao");
    expect(s.undo().changed[0]!.edit).toMatchObject({ translator: "An" }); // back to An's "A"
    expect(s.item(0)[1]).toBe("A");
    const back = s.undo();
    expect(back.changed[0]!.edit).toBeNull();
    expect(back.status).toEqual({ dirtyCount: 0, canUndo: false, canRedo: true });
    s.redo();
    s.redo();
    expect(s.item(0)[1]).toBe("B");
    expect(s.editInfo(0)?.translator).toBe("Bình");
  });

  test("a new edit clears the redo branch", () => {
    const s = opened();
    s.edit(0, "A", "An");
    s.undo();
    expect(s.edit(1, "B", "An").status.canRedo).toBe(false);
  });

  test("reverting to the original name is an undoable step", () => {
    const s = opened();
    s.edit(0, "A", "An");
    expect(s.revert(0, "An").status.dirtyCount).toBe(0);
    s.undo();
    expect(s.item(0)[1]).toBe("A");
  });

  test("refuses to open another file with unsaved changes unless discarding", () => {
    const s = opened();
    s.edit(0, "A", "An");
    expect(() => s.open(file)).toThrow(DirtyError);
    expect(() => s.open(path.join(dir, "khong-co.bmd"))).toThrow(expect.objectContaining({ code: "ENOENT" }));
    s.open(file, { discard: true });
    expect(s.status().dirtyCount).toBe(0);
    expect(readDraft(file)).toBeNull();
  });
});

describe("save", () => {
  test("save: writes file, backs up the old one, logs changes, deletes draft", () => {
    const s = opened();
    s.edit(slotOf(7, 1), "Mũ Rồng Lửa", "An");
    tick();
    s.edit(0, "Chùy Nước", "Bình");
    const r = s.save();

    expect(r.savedCount).toBe(2);
    expect(nameOnDisk(slotOf(7, 1))).toBe("Mũ Rồng Lửa");
    expect(ItemBmd.parse(new Uint8Array(fs.readFileSync(file))).checksumValid).toBe(true);
    expect(Buffer.from(fs.readFileSync(r.backupPath!)).equals(Buffer.from(ORIGINAL))).toBe(true);

    const log = fs.readFileSync(r.logPath, "utf-8").trim().split("\n");
    expect(log[0]).toBe("Time\tTranslator\tItemType\tItemIndex\tOldName\tNewName");
    expect(log).toContain("2026-09-28T04:00:01.000Z\tBình\t0\t0\tChùy Thủy\tChùy Nước");
    expect(log).toContain("2026-09-28T04:00:00.000Z\tAn\t7\t1\tMũ Rồng Đỏ\tMũ Rồng Lửa");

    expect(readDraft(file)).toBeNull();
    expect(s.status().dirtyCount).toBe(0);
    expect(s.status().canUndo).toBe(true);
  });

  test("no changes -> no write, no backup", () => {
    const r = opened().save();
    expect(r.savedCount).toBe(0);
    expect(r.backupPath).toBeNull();
    expect(fs.existsSync(workDir(file))).toBe(false);
  });

  test("undo after saving, then save again", () => {
    const s = opened();
    s.edit(0, "A", "An");
    s.save();
    s.undo();
    expect(s.status().dirtyCount).toBe(1);
    tick();
    s.save();
    expect(nameOnDisk(0)).toBe("Chùy Thủy");
  });

  test("detects the file changing on disk (Drive sync) and overwrites with force", () => {
    const s = opened();
    s.edit(0, "A", "An");
    const other = ItemBmd.parse(ORIGINAL);
    other.setName(1, "Người khác sửa");
    fs.writeFileSync(file, other.toBytes());

    expect(() => s.save()).toThrow(ConflictError);
    expect(nameOnDisk(1)).toBe("Người khác sửa");
    s.save({ force: true });
    expect(nameOnDisk(0)).toBe("A");
  });

  test("save as another file and switch to it", () => {
    const s = opened();
    s.edit(0, "A", "An");
    const dest = path.join(dir, "Item_new.bmd");
    const r = s.save({ path: dest });
    expect(r.file.path).toBe(dest);
    expect(r.backupPath).toBeNull();
    expect(ItemBmd.parse(new Uint8Array(fs.readFileSync(dest))).getName(0).text).toBe("A");
    expect(nameOnDisk(0)).toBe("Chùy Thủy"); // original file unchanged
  });

  test(`keeps at most ${MAX_BACKUPS} backups`, () => {
    const s = opened();
    for (let i = 0; i < MAX_BACKUPS + 3; i++) {
      s.edit(0, `Tên ${i}`, "An");
      tick();
      s.save();
    }
    const backups = fs.readdirSync(path.join(workDir(file), "backups"));
    expect(backups.filter((f) => /^Item-.*\.bmd$/.test(f)).length).toBe(MAX_BACKUPS);
    expect(backups.filter((f) => /^project-.*\.json$/.test(f)).length).toBe(MAX_BACKUPS);
  });
});

describe("draft", () => {
  test("every edit writes the draft; undoing everything deletes it", () => {
    const s = opened();
    s.edit(0, "A", "An");
    expect(readDraft(file)?.slots).toEqual([
      { slot: 0, name: "A", record: { status: "translated", note: "", translator: "An", updatedAt: "2026-09-28T04:00:00.000Z", origin: "Chùy Thủy" } },
    ]);
    s.undo();
    expect(readDraft(file)).toBeNull();
  });

  test("reopening after a crash restores the draft as one undo step", () => {
    const s1 = opened();
    s1.edit(0, "A", "An");
    s1.edit(1, "B", "Bình");

    const s2 = opened();
    expect(s2.draftInfo()).toMatchObject({ count: 2, translators: ["An", "Bình"], baseMatches: true });
    const r = s2.restoreDraft();
    expect(r.skipped).toBe(0);
    expect(r.status.dirtyCount).toBe(2);
    expect(s2.editInfo(1)?.translator).toBe("Bình");
    expect(s2.draftInfo()).toBeNull();
    s2.undo();
    expect(s2.status().dirtyCount).toBe(0);
  });

  test("a draft made against a different file version (disk changed) is flagged", () => {
    opened().edit(0, "A", "An");
    const other = ItemBmd.parse(ORIGINAL);
    other.setName(5, "Khác");
    fs.writeFileSync(file, other.toBytes());
    expect(opened().draftInfo()?.baseMatches).toBe(false);
  });

  test("editing without answering the draft prompt archives the old draft instead of losing it", () => {
    opened().edit(0, "A", "An");
    const s2 = opened();
    s2.edit(1, "B", "Bình");
    const files = fs.readdirSync(workDir(file));
    expect(files.some((f) => /^draft-\d{8}-\d{6}\.json$/.test(f))).toBe(true);
    expect(readDraft(file)?.slots.map((e) => e.slot)).toEqual([1]);
  });

  test("discard draft", () => {
    opened().edit(0, "A", "An");
    const s2 = opened();
    s2.discardDraft();
    expect(readDraft(file)).toBeNull();
    expect(opened().draftInfo()).toBeNull();
  });
});

describe("status, note and project.json", () => {
  const project = () => JSON.parse(fs.readFileSync(projectPath(file), "utf-8"));

  test("editing a name marks it translated and remembers the merge base", () => {
    const s = opened();
    s.edit(0, "A", "An");
    expect(s.record(0)).toMatchObject({ status: "translated", translator: "An", origin: "Chùy Thủy" });
    s.edit(0, "B", "Bình");
    expect(s.record(0).origin).toBe("Chùy Thủy"); // base stays the name before the first change
  });

  test("bulk status change is one undo step and counts as unsaved", () => {
    const s = opened();
    const r = s.setStatus([0, 1, 2], "reviewed", "An");
    expect(r.changed.map((c) => [c.item[0], c.record.status, c.dirty])).toEqual([
      [0, "reviewed", true],
      [1, "reviewed", true],
      [2, "reviewed", true],
    ]);
    expect(r.status.dirtyCount).toBe(3);
    s.undo();
    expect(s.status().dirtyCount).toBe(0);
  });

  test("setting the saved status / note back makes the slot clean again", () => {
    const s = opened();
    s.setStatus([0], "reviewed", "An");
    s.setStatus([0], "untranslated", "An");
    expect(s.status().dirtyCount).toBe(0);
    s.setNote(0, "check\twith team", "An");
    expect(s.record(0).note).toBe("check with team");
    s.setNote(0, "", "An");
    expect(s.status().dirtyCount).toBe(0);
  });

  test("typing the original name again restores the saved record", () => {
    const s = opened();
    s.edit(0, "A", "An");
    s.edit(0, "Chùy Thủy", "An");
    expect(s.status().dirtyCount).toBe(0);
    expect(s.record(0).status).toBe("untranslated");
  });

  test("save writes project.json; reopening restores statuses", () => {
    const s = opened();
    s.edit(0, "A", "An");
    s.setStatus([1], "reviewed", "Bình");
    s.setNote(2, "ghi chú", "Bình");
    expect(s.save().savedCount).toBe(3);
    expect(project().records).toMatchObject({ 0: { status: "translated" }, 1: { status: "reviewed" }, 2: { note: "ghi chú" } });

    const s2 = opened();
    expect(s2.wasRebased()).toBe(false);
    expect(s2.record(1)).toMatchObject({ status: "reviewed", translator: "Bình" });
    expect(s2.status().dirtyCount).toBe(0);
  });

  test("status-only save does not rewrite Item.bmd", () => {
    const s = opened();
    s.setStatus([0], "reviewed", "An");
    const r = s.save();
    expect(r.backupPath).toBeNull();
    expect(Buffer.from(fs.readFileSync(file)).equals(Buffer.from(ORIGINAL))).toBe(true);
  });

  test("project.json changed on disk after opening -> conflict", () => {
    const s = opened();
    s.setStatus([0], "reviewed", "An");
    fs.mkdirSync(workDir(file), { recursive: true });
    fs.writeFileSync(projectPath(file), '{"version":1,"bmdSha1":"x","records":{}}');
    expect(() => s.save()).toThrow(ConflictError);
  });

  test("Item.bmd replaced from outside since the last save -> merge bases reset once", () => {
    const s = opened();
    s.edit(0, "A", "An");
    s.save();
    // a new master copy arrives with a different name in slot 0
    const master = ItemBmd.parse(ORIGINAL);
    master.setName(0, "Master");
    fs.writeFileSync(file, master.toBytes());

    const s2 = opened();
    expect(s2.wasRebased()).toBe(true);
    expect(s2.record(0).origin).toBe("Master");
    expect(opened().wasRebased()).toBe(false); // persisted: reported only once
  });

  test("draft keeps status-only changes too", () => {
    opened().setStatus([5], "reviewed", "An");
    const s2 = opened();
    expect(s2.draftInfo()?.count).toBe(1);
    s2.restoreDraft();
    expect(s2.record(5).status).toBe("reviewed");
  });

  test("a version-1 draft (names only) is still restored", () => {
    fs.mkdirSync(workDir(file), { recursive: true });
    fs.writeFileSync(
      path.join(workDir(file), "draft.json"),
      JSON.stringify({ version: 1, baseSha1: "", savedAt: "2026-09-28T04:00:00.000Z", edits: [{ slot: 0, name: "Cũ", translator: "An", at: "t" }] }),
    );
    const s = opened();
    s.restoreDraft();
    expect(s.item(0)[1]).toBe("Cũ");
    expect(s.record(0)).toMatchObject({ status: "translated", translator: "An" });
  });
});

describe("TSV export / import", () => {
  const tsvPath = () => path.join(dir, "out.tsv");

  test("export -> another copy edits -> import applies only their changes", () => {
    // Translator copy
    const theirDir = fs.mkdtempSync(path.join(os.tmpdir(), "mubmd-their-"));
    const theirFile = path.join(theirDir, "Item.bmd");
    fs.writeFileSync(theirFile, ORIGINAL);
    const them = new Session(now);
    them.open(theirFile);
    them.edit(0, "Chùy Của Họ", "Bình"); // only they change slot 0
    them.edit(1, "Đao Của Họ", "Bình"); // both change slot 1 -> conflict
    them.setStatus([2], "reviewed", "Bình"); // status-only change on slot 2
    them.exportTsv(tsvPath(), [0, 1, 2, 3]);
    fs.rmSync(theirDir, { recursive: true, force: true });

    // Master copy
    const s = opened();
    s.edit(1, "Đao Của Mình", "An");
    const p = s.previewImport(tsvPath());
    expect(p.hasBase).toBe(true);
    expect(p.items.map((i) => [i.slot, i.kind, i.take])).toEqual([
      [0, "apply", true],
      [1, "conflict", false],
      [2, "status", true],
    ]);
    expect(p.items[1]).toMatchObject({ base: "Đoản Đao", ours: "Đao Của Mình", theirs: "Đao Của Họ" });
    expect(p.counts.same).toBe(1); // slot 3 unchanged on both sides

    const r = s.applyImport(tsvPath(), p.token, [0, 2], "An");
    expect(r.changed.map((c) => c.item[0])).toEqual([0, 2]);
    expect(s.item(0)[1]).toBe("Chùy Của Họ");
    expect(s.record(0)).toMatchObject({ status: "translated", translator: "Bình", origin: "Chùy Thủy" });
    expect(s.item(1)[1]).toBe("Đao Của Mình");
    expect(s.record(2).status).toBe("reviewed");
    s.undo(); // the whole import is one step
    expect(s.item(0)[1]).toBe("Chùy Thủy");
    expect(s.record(2).status).toBe("untranslated");
  });

  test("apply refuses if the file changed after the preview", () => {
    const s = opened();
    fs.writeFileSync(tsvPath(), "ItemType\tItemIndex\tName\n0\t0\tX\n");
    const p = s.previewImport(tsvPath());
    fs.writeFileSync(tsvPath(), "ItemType\tItemIndex\tName\n0\t0\tY\n");
    expect(() => s.applyImport(tsvPath(), p.token, [0], "An")).toThrow(expect.objectContaining({ code: "import-changed" }));
  });

  test("the old items.tsv (no BaseName) imports as plain changes", () => {
    const s = opened();
    fs.writeFileSync(tsvPath(), "ItemType\tItemIndex\tName\n0\t0\tChùy Thủy\n0\t1\tĐoản Đao Mới\n");
    const p = s.previewImport(tsvPath());
    expect(p.hasBase).toBe(false);
    expect(p.items.map((i) => [i.slot, i.kind, i.base])).toEqual([[1, "apply", null]]);
  });

  test("export includes status, base, note and reference names", () => {
    const s = opened();
    const ref = path.join(dir, "ref.tsv");
    fs.writeFileSync(ref, "ItemType\tItemIndex\tName(Japanese)\n0\t0\tクリス\n");
    expect(s.setReference(ref)?.entries).toEqual([[0, "クリス"]]);
    s.edit(0, "Chùy Mới", "An");
    s.setNote(0, "ok", "An");
    s.exportTsv(tsvPath(), [0]);
    const text = fs.readFileSync(tsvPath(), "utf-8");
    expect(text.startsWith("\uFEFF")).toBe(true);
    expect(text.split("\n")[1]).toBe("0\t0\tChùy Mới\ttranslated\tAn\t2026-09-28T04:00:00.000Z\tChùy Thủy\tクリス\tok");
  });

  test("an Item.bmd can be used as reference", () => {
    const s = opened();
    expect(s.setReference(DATA)?.entries.length).toBe(488);
    expect(s.setReference(null)).toBeNull();
  });
});
