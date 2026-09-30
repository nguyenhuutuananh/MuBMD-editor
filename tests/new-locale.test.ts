import { describe, expect, test } from "bun:test";
import { AppError, checkEmitter, checkOptionWindow, parseResx, resxValues, wideLiteral } from "../src/core";
import { MemoryStorage } from "../src/session/memoryStorage";
import { EMITTER_FILE, OPTION_WINDOW_FILE, Session } from "../src/session/session";
import { sampleBytes } from "./fixtures/sampleLocalization";

const DIR = "/mu/src/Localization";
const CPP = `static const struct { const char* code; const wchar_t* label; } s_Languages[] = {
    { "en",    L"English" },
    { "de",    L"Deutsch" },
    { "uk",    L"\\u0423\\u043a\\u0440\\u0430\\u0457\\u043d\\u0441\\u044c\\u043a\\u0430" }, // Українська
    { "zh-TW", L"\\u7e41\\u9ad4\\u4e2d\\u6587" },                                      // 繁體中文
};`;
const CS = `            ["de"]    = "Deutsch",
            ["en"]    = "English",
            ["vi"]    = "Tiếng Việt",
            ["zh-TW"] = "繁體中文",`;

function setup(withSources = true) {
  const files = Object.fromEntries(Object.entries(sampleBytes()).map(([n, b]) => [`${DIR}/${n}`, b]));
  if (withSources) {
    files["/mu/src/source/UI/NewUI/Options/NewUIOptionWindow.cpp"] = new TextEncoder().encode(CPP);
    files["/mu/tools/ResxGen/CppEmitter.cs"] = new TextEncoder().encode(CS);
  }
  const st = new MemoryStorage(files);
  return { st, s: new Session(st) };
}

describe("registration check", () => {
  test("lines to add, in the files' own style and order", () => {
    expect(wideLiteral("Tiếng Việt")).toBe('L"Ti\\u1ebfng Vi\\u1ec7t"');
    expect(wideLiteral("😀")).toBe('L"\\U0001f600"');
    const vi = checkOptionWindow(CPP, "vi", "Tiếng Việt");
    expect(vi).toEqual({
      registered: false,
      codes: ["en", "de", "uk", "zh-TW"],
      line: '    { "vi",    L"Ti\\u1ebfng Vi\\u1ec7t" }, // Tiếng Việt',
      after: "uk",
    });
    expect(checkOptionWindow(CPP, "ar", "ar").after).toBe("en"); // before every other: right after en
    expect(checkOptionWindow(CPP, "de", "Deutsch").registered).toBe(true);
    expect(checkEmitter(CS, "vi", "Tiếng Việt").registered).toBe(true);
    expect(checkEmitter(CS, "th", "ไทย")).toMatchObject({ registered: false, line: '            ["th"]    = "ไทย",', after: "en" });
    expect(checkEmitter(CS, "ar", "ar").after).toBe(null);
  });

  test("session: read next to the folder; null when the files are not there", async () => {
    const { s } = setup();
    await s.openFolder(DIR, "vi");
    const r = await s.registration();
    expect(r).toMatchObject({ locale: "vi", name: "Tiếng Việt", optionWindow: { path: OPTION_WINDOW_FILE, registered: false, after: "uk" } });
    expect(r.emitter).toMatchObject({ path: EMITTER_FILE, registered: true });
    const bare = setup(false);
    await bare.s.openFolder(DIR, "vi");
    expect(await bare.s.registration()).toMatchObject({ optionWindow: null, emitter: null });
  });
});

describe("new locale", () => {
  test("opened with create: every key untranslated, nothing written until saved", async () => {
    const { s, st } = setup();
    const before = new Set(st.files.keys());
    await s.openFolder(DIR, "th", null, { create: true });
    const rows = s.rows();
    expect(rows.groups.map((g) => [g.name, g.file, g.progress.translated])).toEqual([
      ["Dialog", null, 0],
      ["Editor", null, 0],
      ["Game", null, 0],
    ]);
    expect(new Set(st.files.keys())).toEqual(before);

    await s.edit("Game", "Event", "เหตุการณ์", "An");
    await s.setKeep("Game", "Gulim", true, "An");
    const saved = await s.save();
    expect(saved.created).toEqual(["src/Localization/Game.th.resx"]);
    const th = resxValues(parseResx(st.files.get(`${DIR}/Game.th.resx`)!));
    expect([...th.keys()]).toEqual(["Gulim", "Event"]); // en order
    expect(th.get("Gulim")!.comment).toBe("legacy_id=0,18; keep");
    expect(s.open!.folder.locales.map((l) => l.code)).toEqual(["en", "de", "th", "vi"]);
    expect((await s.registration()).optionWindow).toMatchObject({ registered: false, after: "de" });
  });

  test("bad codes, en, or an existing locale without create", async () => {
    const { s } = setup();
    const code = async (p: Promise<unknown>) => p.then(() => undefined, (e: AppError) => e.code);
    expect(await code(s.openFolder(DIR, "Thai", null, { create: true }))).toBe("locale-code");
    expect(await code(s.openFolder(DIR, "en", null, { create: true }))).toBe("locale-not-found");
    expect(await code(s.openFolder(DIR, "th"))).toBe("locale-not-found");
    await s.openFolder(DIR, "vi", null, { create: true }); // existing: create is harmless
    expect(s.rows().groups[2]!.file).toBe("src/Localization/Game.vi.resx");
  });
});
