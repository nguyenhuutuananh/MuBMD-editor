import { describe, expect, test } from "bun:test";
import { findItemsFolder, hostPlatform } from "../src/session/itemsFolder";
import { MemoryStorage } from "../src/session/memoryStorage";

const J = new TextEncoder().encode("{}");
// A storage holding a Group00_Sword.json in each given item folder (plus some unrelated files).
const storage = (...itemDirs: string[]) =>
  new MemoryStorage(
    Object.fromEntries([
      ...itemDirs.map((d) => [`${d}/Group00_Sword.json`, J]),
      ["/g/Main.exe", J],
      ["/g/Data/Local/Item.bmd", J],
      ["/g/Data/Items/Models/Group00_Sword.json", J],
    ]),
  );

describe("findItemsFolder", () => {
  test("Windows / Linux game folder: Data/Items", async () => {
    expect(await findItemsFolder(storage("/g/Data/Items"), "/g", "win32")).toEqual({ root: "/g", dir: "/g/Data/Items", layout: "game" });
    expect((await findItemsFolder(storage("/g/Data/Items"), "/g", "darwin")).dir).toBe("/g/Data/Items");
  });

  test("macOS: inside the app bundle, whatever it is called", async () => {
    const st = storage("/g/Main.app/Contents/MacOS/Data/Items");
    expect(await findItemsFolder(st, "/g", "darwin")).toEqual({ root: "/g", dir: "/g/Main.app/Contents/MacOS/Data/Items", layout: "app" });
    expect((await findItemsFolder(st, "/g/Main.app", "darwin")).dir).toBe("/g/Main.app/Contents/MacOS/Data/Items");
    expect((await findItemsFolder(storage("/g/MU Online.app/Contents/MacOS/Data/Items"), "/g", "linux")).layout).toBe("app");
  });

  test("both layouts in one folder: the one of this computer's OS wins", async () => {
    const st = storage("/g/Data/Items", "/g/Main.app/Contents/MacOS/Data/Items", "/g/Other.app/Contents/MacOS/Data/Items");
    expect((await findItemsFolder(st, "/g", "darwin")).dir).toBe("/g/Main.app/Contents/MacOS/Data/Items");
    expect((await findItemsFolder(st, "/g", "win32")).dir).toBe("/g/Data/Items");
    expect((await findItemsFolder(st, "/g", "linux")).dir).toBe("/g/Data/Items");
  });

  test("picking Data/Items or Data directly", async () => {
    const st = storage("/g/Data/Items");
    expect((await findItemsFolder(st, "/g/Data/Items", "win32")).layout).toBe("items");
    expect(await findItemsFolder(st, "/g/Data", "win32")).toEqual({ root: "/g/Data", dir: "/g/Data/Items", layout: "data" });
  });

  test("a MuMain checkout: the source data, not a build output", async () => {
    const st = storage("/repo/src/bin/Data/Items", "/repo/out/build/macos-arm64/src/Release/Main.app/Contents/MacOS/Data/Items");
    expect(await findItemsFolder(st, "/repo", "darwin")).toEqual({ root: "/repo", dir: "/repo/src/bin/Data/Items", layout: "source" });
    // the build output can still be opened by picking it
    expect((await findItemsFolder(st, "/repo/out/build/macos-arm64/src/Release", "darwin")).layout).toBe("app");
  });

  test("no item data -> items-not-found (Data/Local and Items/Models do not count)", async () => {
    await expect(findItemsFolder(storage(), "/g", "win32")).rejects.toThrow(expect.objectContaining({ code: "items-not-found" }));
  });

  test("hostPlatform", () => {
    expect(hostPlatform("darwin")).toBe("darwin");
    expect(hostPlatform("freebsd")).toBe("other");
  });
});
