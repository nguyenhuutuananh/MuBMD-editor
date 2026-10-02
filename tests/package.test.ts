// Translation packages: export a locale from one checkout, import it into another.
import { describe, expect, test } from "bun:test";
import { AppError, readPackage, unzip, zip } from "../src/core";
import { MemoryStorage } from "../src/session/memoryStorage";
import { Session } from "../src/session/session";
import { RESX_REL, sampleCheckout } from "./fixtures/sampleWorkspace";

const ROOT = "/mu";
const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);
const GLOSSARY = "Term\tTranslation\tNote\tCategory\tSource\tStatus\nChaos Castle\tLâu Đài Hỗn Loạn\t\t\t\tconfirmed\n";

async function checkout(files = sampleCheckout(ROOT)) {
  let t = Date.parse("2026-10-01T10:00:00Z");
  const st = new MemoryStorage(files);
  const s = new Session(st, () => new Date((t += 1000)), "win32");
  await s.openFolder(ROOT, "vi");
  return { s, st };
}
const valueOf = (s: Session, group: string, key: string) => s.rows().rows.find((r) => s.rows().groups[r[0]]!.name === group && r[1] === key)![3];

async function exported() {
  const a = await checkout();
  a.st.files.set("/kit/glossary.tsv", enc(GLOSSARY));
  await a.s.edit("Game", "Chaos Castle", "Lâu Đài Hỗn Loạn", "An");
  await a.s.edit("Items.Helm", "1", "Mũ Rồng", "An");
  await a.s.setNote("Game", "Event", "kiểm tra lại", "An");
  await a.s.save();
  const res = await a.s.exportPackage("/out/vi.zip", { glossary: "/kit/glossary.tsv", translator: "An", tool: "2.0.0" });
  return { a, res, bytes: a.st.files.get("/out/vi.zip")! };
}

describe("export", () => {
  test("manifest, TSV of every key, the saved files, the glossary, a README", async () => {
    const { a, res, bytes } = await exported();
    expect(res).toMatchObject({ path: "/out/vi.zip", glossary: true });
    const names = unzip(bytes).map((e) => e.name);
    expect(names.slice(0, 4)).toEqual(["manifest.json", "README.txt", "translations.tsv", "glossary.tsv"]);
    expect(names).toContain(`files/${RESX_REL}/Game.vi.resx`);
    expect(names).toContain("files/src/bin/Data/Items/Group07_Helm.json");
    expect(names).not.toContain(`files/${RESX_REL}/Game.en.resx`); // only the translations
    const pkg = readPackage(bytes);
    expect(pkg.manifest).toMatchObject({ format: "mumain-translator-package", locale: "vi", by: "An", tool: "2.0.0", glossary: true });
    expect(pkg.manifest.rows).toBe(res.rows);
    expect(pkg.translations).toContain("Game\tChaos Castle\tChaos Castle\tLâu Đài Hỗn Loạn\ttranslated\tAn");
    expect(pkg.translations).toContain("kiểm tra lại");
    const game = unzip(bytes).find((e) => e.name.endsWith("Game.vi.resx"))!;
    expect(game.bytes).toEqual(a.st.files.get(`${ROOT}/${RESX_REL}/Game.vi.resx`)!); // as saved on disk
    expect(pkg.glossary).toContain("Lâu Đài Hỗn Loạn");
  });

  test("unsaved edits block it", async () => {
    const { s } = await checkout();
    await s.edit("Game", "Event", "Sự Kiện", "An");
    await expect(s.exportPackage("/out/vi.zip", { translator: "An", tool: "x" })).rejects.toMatchObject({ code: "dirty" });
  });
});

describe("import", () => {
  test("into a checkout of the same version: the changed keys apply, nothing outdated", async () => {
    const { bytes } = await exported();
    const b = await checkout();
    b.st.files.set("/in/vi.zip", bytes);
    const p = await b.s.previewImport("/in/vi.zip");
    expect(p.package).toMatchObject({ locale: "vi", by: "An", glossary: true, englishChanged: [] });
    expect(p.package!.files).toBeGreaterThan(10);
    const keys = p.items.filter((i) => i.take).map((i) => i.key).sort();
    expect(keys).toEqual(["1", "Chaos Castle"]); // a note alone (Event) is not merged, like any TSV import
    await b.s.applyImport("/in/vi.zip", p.token, p.items.filter((i) => i.take).map((i) => [i.group, i.key]), "Bình");
    expect(valueOf(b.s, "Game", "Chaos Castle")).toBe("Lâu Đài Hỗn Loạn");
    expect(valueOf(b.s, "Items.Helm", "1")).toBe("Mũ Rồng");
  });

  test("another MuMain version: groups with other English are named, changed rows not taken by default", async () => {
    const { bytes } = await exported();
    const files = sampleCheckout(ROOT);
    const en = `${ROOT}/${RESX_REL}/Game.en.resx`;
    files[en] = enc(dec(files[en]!).replace("<value>Chaos Castle</value>", "<value>Chaos Castle (event)</value>"));
    const b = await checkout(files);
    b.st.files.set("/in/vi.zip", bytes);
    const p = await b.s.previewImport("/in/vi.zip");
    expect(p.package!.englishChanged).toEqual(["Game"]);
    const cc = p.items.find((i) => i.key === "Chaos Castle")!;
    expect([cc.kind, cc.take, cc.theirEnglish]).toEqual(["apply", false, "Chaos Castle"]);
    expect(p.items.find((i) => i.key === "1")!.take).toBe(true);
  });

  test("a package unzipped and zipped again inside a folder still imports", async () => {
    const { bytes } = await exported();
    const again = zip(unzip(bytes).map((e) => ({ name: `MuMain-vi/${e.name}`, bytes: e.bytes })));
    const b = await checkout();
    b.st.files.set("/in/again.zip", again);
    expect((await b.s.previewImport("/in/again.zip")).package?.locale).toBe("vi");
  });

  test("a package of another locale, or a zip that is no package", async () => {
    const { bytes } = await exported();
    const b = new Session(new MemoryStorage({ ...sampleCheckout(ROOT), "/in/vi.zip": bytes, "/in/other.zip": zip([{ name: "a.txt", bytes: enc("x") }]) }), undefined, "win32");
    await b.openFolder(ROOT, "de");
    await expect(b.previewImport("/in/vi.zip")).rejects.toMatchObject({ code: "package-locale", params: { locale: "vi", open: "de" } });
    await b.openFolder(ROOT, "vi");
    const err = await b.previewImport("/in/other.zip").catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe("package-invalid");
  });

  test("the glossary of the package goes to the side data folder", async () => {
    const { bytes } = await exported();
    const b = await checkout();
    b.st.files.set("/in/vi.zip", bytes);
    const p = await b.s.previewImport("/in/vi.zip");
    const path = await b.s.importPackageGlossary("/in/vi.zip", p.token);
    expect(path).toBe(`${ROOT}/.mumain-translator/glossary-vi.tsv`);
    expect(dec(b.st.files.get(path)!)).toContain("Lâu Đài Hỗn Loạn");
  });
});
