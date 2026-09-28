import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ItemBmd, NameValidationError, slotOf } from "../src/core";
import { ConflictError, DirtyError, Session } from "../src/server/session";
import { MAX_BACKUPS, readDraft, workDir } from "../src/server/storage";

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
    expect(fs.readdirSync(path.join(workDir(file), "backups")).length).toBe(MAX_BACKUPS);
  });
});

describe("draft", () => {
  test("every edit writes the draft; undoing everything deletes it", () => {
    const s = opened();
    s.edit(0, "A", "An");
    expect(readDraft(file)?.edits).toEqual([{ slot: 0, name: "A", translator: "An", at: "2026-09-28T04:00:00.000Z" }]);
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
    expect(readDraft(file)?.edits.map((e) => e.slot)).toEqual([1]);
  });

  test("discard draft", () => {
    opened().edit(0, "A", "An");
    const s2 = opened();
    s2.discardDraft();
    expect(readDraft(file)).toBeNull();
    expect(opened().draftInfo()).toBeNull();
  });
});
