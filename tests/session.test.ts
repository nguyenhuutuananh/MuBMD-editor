import { describe, expect, test } from "bun:test";
import { AppError, type ErrorCode } from "../src/core";
import { MemoryStorage } from "../src/session/memoryStorage";
import { Session } from "../src/session/session";
import type { RowTuple } from "../src/shared/api";
import { resxText, sampleBytes } from "./fixtures/sampleLocalization";

const DIR = "/mu/src/Localization";

function setup(files: Record<string, Uint8Array> = sampleBytes()) {
  const st = new MemoryStorage(Object.fromEntries(Object.entries(files).map(([n, b]) => [`${DIR}/${n}`, b])));
  return new Session(st, () => new Date("2026-09-29T10:00:00Z"));
}

async function codeOf(p: Promise<unknown>): Promise<ErrorCode | undefined> {
  try {
    await p;
  } catch (e) {
    if (e instanceof AppError) return e.code;
    throw e;
  }
  return undefined;
}

const row = (rows: RowTuple[], key: string) => rows.find((r) => r[1] === key)!;
const codes = (r: RowTuple) => r[5].map((i) => i[0]);

describe("scan", () => {
  test("lists groups and locales (en first), skipped files", async () => {
    const listing = await setup().scan(DIR);
    expect(listing.path).toBe("/mu"); // the checkout: side data goes to /mu/.mumain-translator
    expect(listing.resx?.rel).toBe("src/Localization");
    expect(listing.items).toBeNull();
    expect(listing.resx!.groups.map((g) => [g.name, g.locales])).toEqual([
      ["Dialog", ["en"]],
      ["Editor", ["en", "vi"]],
      ["Game", ["en", "de", "vi"]],
    ]);
    expect(listing.locales).toEqual([
      { code: "en", groups: 3 },
      { code: "de", groups: 1 },
      { code: "vi", groups: 2 },
    ]);
    expect(listing.resx!.skipped).toEqual(["Game.vi.resx.bak"]);
  });

  test("clear errors", async () => {
    const s = setup();
    expect(await codeOf(s.scan("/nope"))).toBe("file-not-found");
    expect(await codeOf(s.scan(`${DIR}/Game.en.resx`))).toBe("not-a-folder");
    expect(await codeOf(setup({ "notes.txt": new Uint8Array() }).scan(DIR))).toBe("nothing-to-translate");
    expect(await codeOf(setup({ "Game.vi.resx": new TextEncoder().encode(resxText([])) }).scan(DIR))).toBe("no-default");
  });
});

describe("open + rows", () => {
  test("one row per en key, then keys only the translation has", async () => {
    const s = setup();
    const info = await s.openFolder(DIR, "vi");
    expect(info).toMatchObject({ locale: "vi", reference: null, loadedAt: "2026-09-29T10:00:00.000Z" });
    const { groups, rows, issues } = s.rows();
    expect(groups.map((g) => [g.name, g.enFile, g.file])).toEqual([
      ["Dialog", "src/Localization/Dialog.en.resx", null],
      ["Editor", "src/Localization/Editor.en.resx", "src/Localization/Editor.vi.resx"],
      ["Game", "src/Localization/Game.en.resx", "src/Localization/Game.vi.resx"],
    ]);
    expect(rows.filter((r) => r[0] === 1).map((r) => [r[1], r[3]])).toEqual([
      ["Save Items", "Lưu vật phẩm"],
      ["Index {0} is already in use", "Chỉ số đã được dùng"],
      ["Export as CSV", null],
    ]);
    const extra = row(rows, "Removed key");
    expect([extra[2], extra[3], codes(extra)]).toEqual([null, "Khoá đã bị xoá khỏi en", ["extra-key"]]);
    expect(issues).toEqual([]);
  });

  test("issues are attached to their rows (target and en)", async () => {
    const s = setup();
    await s.openFolder(DIR, "vi");
    const { rows } = s.rows();
    expect(codes(row(rows, "(%s) stat %d points have been generated."))).toEqual(["printf-mismatch"]);
    expect(codes(row(rows, "ItemShop30Days"))).toEqual(["newline-mismatch", "stray-backslash"]);
    expect(codes(row(rows, "Increase Max HP +4%%"))).toEqual(["percent-style"]);
    expect(codes(row(rows, "Gulim"))).toEqual(["same-as-en"]);
    expect(codes(row(rows, "몬스터"))).toEqual(["no-identifier"]); // en issue, value not checked
    expect(codes(row(rows, "Index {0} is already in use"))).toEqual(["format-arg-mismatch"]);
    expect(row(rows, "(%s) stat %d points have been generated.")[5][0]).toEqual(["printf-mismatch", "vi", { expected: "%s %d", actual: "%d %s" }]);
    expect(row(rows, "몬스터")[5][0]).toEqual(["no-identifier", "en"]);
    expect(row(rows, "Gulim")[6]).toEqual([0, 18]);
  });

  test("progress and counts per group", async () => {
    const s = setup();
    await s.openFolder(DIR, "vi");
    const game = s.rows().groups[2]!;
    expect(game.progress).toEqual({ total: 11, translated: 8, sameAsEn: 1, kept: 0, extra: 1 });
    expect(game.counts).toEqual({ error: 1, warning: 4, info: 2 }); // warnings: \n, stray \, %, extra key; info: same as en, no identifier
    const dialog = s.rows().groups[0]!;
    expect(dialog.progress).toEqual({ total: 2, translated: 0, sameAsEn: 0, kept: 0, extra: 0 });
  });

  test("line numbers of en and of the translation", async () => {
    const s = setup();
    await s.openFolder(DIR, "vi");
    const r = row(s.rows().rows, "Event");
    expect([r[7], r[8]]).toEqual([29, 24]); // en entries have a <comment> line, vi ones do not
  });

  test("reference locale", async () => {
    const s = setup();
    await s.openFolder(DIR, "vi", "de");
    expect(row(s.rows().rows, "Event")[4]).toBe("Ereignis");
    expect(s.rows().groups[2]!.referenceFile).toBe("src/Localization/Game.de.resx");
    await s.setReference(null);
    expect(row(s.rows().rows, "Event")[4]).toBeNull();
    await s.setReference("de");
    expect(row(s.rows().rows, "Level %d")[4]).toBe("Stufe %d");
    expect(await codeOf(s.setReference("ja"))).toBe("locale-not-found");
    // en or the target itself is not a reference
    await s.setReference("vi");
    expect(s.open!.reference).toBeNull();
  });

  test("errors keep the folder that was open", async () => {
    const files = sampleBytes();
    const s = setup({ ...files, "Broken.en.resx": new TextEncoder().encode("<root><data name='a'><value>x</data></root>") });
    expect(await codeOf(s.openFolder(DIR, "vi"))).toBe("resx-xml");
    try {
      await s.openFolder(DIR, "vi");
    } catch (e) {
      expect((e as AppError).params).toMatchObject({ file: "Broken.en.resx", line: 1 });
    }
    expect(s.open).toBeNull();

    const ok = setup();
    await ok.openFolder(DIR, "vi");
    expect(await codeOf(ok.openFolder(DIR, "ja"))).toBe("locale-not-found");
    expect(await codeOf(ok.openFolder(DIR, "en"))).toBe("locale-not-found");
    expect(ok.open!.locale).toBe("vi");
  });

  test("rows before opening", () => {
    expect(() => setup().rows()).toThrow();
  });
});
