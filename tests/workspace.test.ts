import { describe, expect, test } from "bun:test";
import { AppError } from "../src/core";
import { MemoryStorage } from "../src/session/memoryStorage";
import { findWorkspace, listWorkspace } from "../src/session/workspace";
import { sampleCheckout } from "./fixtures/sampleWorkspace";

const ws = (files: Record<string, Uint8Array>, picked: string, platform: "darwin" | "win32" = "win32") =>
  findWorkspace(new MemoryStorage(files), picked, platform);
const shape = (w: Awaited<ReturnType<typeof findWorkspace>>) => ({
  root: w.root,
  resx: w.resx?.rel ?? null,
  items: w.items ? [w.items.rel, w.items.layout] : null,
});

describe("findWorkspace", () => {
  const checkout = sampleCheckout("/mu");

  test("a MuMain checkout: both sources, the checkout is the root", async () => {
    expect(shape(await ws(checkout, "/mu"))).toEqual({ root: "/mu", resx: "src/Localization", items: ["src/bin/Data/Items", "source"] });
  });

  test("picking src or src/Localization inside it finds the same workspace", async () => {
    const want = { root: "/mu", resx: "src/Localization", items: ["src/bin/Data/Items", "source"] };
    expect(shape(await ws(checkout, "/mu/src"))).toEqual(want);
    expect(shape(await ws(checkout, "/mu/src/Localization"))).toEqual(want);
  });

  test("a game folder: items only (Windows / Linux and macOS layouts)", async () => {
    const win = sampleCheckout("/game", { resx: false, itemsRel: "Data/Items" });
    expect(shape(await ws(win, "/game"))).toEqual({ root: "/game", resx: null, items: ["Data/Items", "game"] });
    const mac = sampleCheckout("/game", { resx: false, itemsRel: "Main.app/Contents/MacOS/Data/Items" });
    expect(shape(await ws(mac, "/game", "darwin"))).toEqual({ root: "/game", resx: null, items: ["Main.app/Contents/MacOS/Data/Items", "app"] });
  });

  test("Data/Items picked directly; a lone Localization folder", async () => {
    const win = sampleCheckout("/game", { resx: false, itemsRel: "Data/Items" });
    expect(shape(await ws(win, "/game/Data/Items"))).toEqual({ root: "/game/Data/Items", resx: null, items: ["", "items"] });
    const lone = sampleCheckout("/x", { items: false });
    expect(shape(await ws(lone, "/x/src/Localization"))).toEqual({ root: "/x", resx: "src/Localization", items: null });
    const moved: Record<string, Uint8Array> = {};
    for (const [p, b] of Object.entries(lone)) moved[p.replace("/x/src/Localization", "/tr/Loc")] = b;
    expect(shape(await ws(moved, "/tr/Loc"))).toEqual({ root: "/tr/Loc", resx: "", items: null });
  });

  test("nothing to translate, missing folders, files", async () => {
    const code = async (p: Promise<unknown>) => p.then(() => null, (e: AppError) => e.code);
    expect(await code(ws({ "/a/readme.txt": new Uint8Array() }, "/a"))).toBe("nothing-to-translate");
    expect(await code(ws(checkout, "/nope"))).toBe("file-not-found");
    expect(await code(ws(checkout, "/mu/src/Localization/Game.en.resx"))).toBe("not-a-folder");
  });
});

describe("listWorkspace", () => {
  test("locales counted over resx groups and item files", async () => {
    const st = new MemoryStorage(sampleCheckout("/mu"));
    const l = await listWorkspace(st, await findWorkspace(st, "/mu", "win32"));
    expect(l.path).toBe("/mu");
    expect(l.resx!.groups.map((g) => g.name)).toEqual(["Dialog", "Editor", "Game"]);
    expect(l.items!.files.length).toBe(14);
    const byCode = Object.fromEntries(l.locales.map((x) => [x.code, x.groups]));
    expect(l.locales[0]!.code).toBe("en");
    expect(byCode.en).toBe(3 + 14);
    expect(byCode.de).toBe(1); // resx only
    expect(byCode.vi).toBeGreaterThan(2); // 2 resx groups + item files with Vietnamese names
    expect(byCode.pt).toBeGreaterThan(0); // items only
  });
});
