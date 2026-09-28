// web.ts - End-to-end test of the WEB build (Session in the browser, File System Access API) in real
// headless Chrome. Native pickers cannot be clicked headlessly, so window.__MUBMD_TEST_PICK__ answers
// them with handles from the page's Origin Private File System (OPFS): the test queues OPFS paths
// with pickNext(); with an empty queue the folder picker returns "Local" (preloaded with the sample).
//   bun tests/e2e/web.ts [screenshot-dir]

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type Browser, type Page, chromium } from "playwright-core";
import { ItemBmd } from "../../src/core";
import { buildSampleBmd } from "../fixtures/sampleBmd";
import { chromiumOptions } from "./browsers";

// The e2e hook read by web/src/lib/localBackend.ts (declared there for the web build too).
declare global {
  interface Window {
    __MUBMD_TEST_PICK__?: (req: { mode: string }) => Promise<FileSystemHandle | null>;
    __pickQueue?: string[];
  }
}

// Answer the next native picker(s) with these OPFS paths ("Local" = folder, "out/x.tsv" = file).
const pickNext = (p: Page, ...paths: string[]) => p.evaluate((q) => (window.__pickQueue = q), paths);

const ROOT = path.join(import.meta.dir, "../..");
const PORT = 4861;
const URL = `http://localhost:${PORT}/`;
const SHOTS = process.argv[2] ?? fs.mkdtempSync(path.join(os.tmpdir(), "mubmd-web-e2e-"));
fs.mkdirSync(SHOTS, { recursive: true });

let failures = 0;
let vite: ReturnType<typeof Bun.spawn> | null = null;
let browser: Browser | null = null;

function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures++;
}

const rowSel = (n: number) => `[data-testid=grid] [data-slot] >> nth=${n}`;
const EDITOR = "[data-testid=inline-editor] input";
const text = async (p: Page, sel: string) => ((await p.textContent(sel)) ?? "").trim();
const shot = (p: Page, name: string) => p.screenshot({ path: path.join(SHOTS, `${name}.png`) });
const waitText = (p: Page, sel: string, want: string) =>
  p.waitForFunction(([s, w]) => document.querySelector(s!)?.textContent?.trim() === w, [sel, want]);

async function toastWith(p: Page, needle: string): Promise<string> {
  const t = p.locator("[data-sonner-toast]", { hasText: needle }).first();
  try {
    await t.waitFor();
    return ((await t.textContent()) ?? "").trim();
  } catch {
    return `(not found; showing: ${(await p.locator("[data-sonner-toast]").allTextContents()).join(" | ") || "none"})`;
  }
}

// ---- OPFS helpers (run inside the page) ----

async function opfsWrite(p: Page, rel: string, bytes: Uint8Array) {
  await p.evaluate(
    async ([relPath, b64]) => {
      let dir = await navigator.storage.getDirectory();
      const parts = relPath!.split("/");
      for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part, { create: true });
      const w = await (await dir.getFileHandle(parts[parts.length - 1]!, { create: true })).createWritable();
      await w.write(Uint8Array.from(atob(b64!), (c) => c.charCodeAt(0)));
      await w.close();
    },
    [rel, Buffer.from(bytes).toString("base64")],
  );
}

async function opfsRead(p: Page, rel: string): Promise<Uint8Array | null> {
  const b64 = await p.evaluate(async (relPath) => {
    try {
      let dir = await navigator.storage.getDirectory();
      const parts = relPath.split("/");
      for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part);
      const buf = new Uint8Array(await (await (await dir.getFileHandle(parts[parts.length - 1]!)).getFile()).arrayBuffer());
      let s = "";
      for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      return btoa(s);
    } catch {
      return null;
    }
  }, rel);
  return b64 === null ? null : new Uint8Array(Buffer.from(b64, "base64"));
}

async function opfsList(p: Page, rel: string): Promise<string[]> {
  return p.evaluate(async (relPath) => {
    try {
      let dir = await navigator.storage.getDirectory();
      for (const part of relPath.split("/").filter(Boolean)) dir = await dir.getDirectoryHandle(part);
      const names: string[] = [];
      for await (const [name] of (dir as unknown as { entries(): AsyncIterable<[string, unknown]> }).entries()) names.push(name);
      return names.sort();
    } catch {
      return [];
    }
  }, rel);
}

async function startVite() {
  vite = Bun.spawn(["node", path.join(ROOT, "node_modules/vite/bin/vite.js"), "--port", String(PORT), "--strictPort"], {
    cwd: ROOT,
    stdout: "ignore",
    stderr: "ignore",
    env: { ...process.env, VITE_TARGET: "web" },
  });
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(URL)).ok) return;
    } catch {
      /* not up yet */
    }
    await Bun.sleep(100);
  }
  throw new Error("vite did not start");
}

async function openFolder(p: Page) {
  await p.goto(URL);
  await p.click("[data-testid=pick]");
}

async function main() {
  await startVite();
  browser = await chromium.launch(chromiumOptions());
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 860 } });
  // Native pickers answered from OPFS paths queued with pickNext().
  await ctx.addInitScript(() => {
    window.__pickQueue = [];
    window.__MUBMD_TEST_PICK__ = async (req) => {
      const next = window.__pickQueue!.shift() ?? (req.mode === "folder" ? "Local" : null);
      if (!next) return null;
      let dir = await navigator.storage.getDirectory();
      const parts = next.split("/");
      if (req.mode === "folder") {
        for (const part of parts) dir = await dir.getDirectoryHandle(part, { create: true });
        return dir;
      }
      for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part, { create: true });
      return dir.getFileHandle(parts[parts.length - 1]!, { create: req.mode === "save" });
    };
  });
  const p = await ctx.newPage();
  p.setDefaultTimeout(10000);
  const errors: string[] = [];
  p.on("pageerror", (e) => errors.push(String(e)));
  // Leaving with unsaved changes shows the browser's "leave site?" dialog: note it and leave.
  let lastDialog = "";
  p.on("dialog", (d) => {
    lastDialog = d.type();
    d.accept().catch(() => undefined);
  });

  await p.goto(URL);
  await opfsWrite(p, "Local/Item.bmd", buildSampleBmd());

  // 1. Welcome screen of the web build: folder picker, no path box
  await p.reload();
  check("web welcome: folder button, no path box", (await text(p, "[data-testid=pick]")).includes("folder") && !(await p.isVisible("#open-path")));

  // 2. Open the folder -> the Item.bmd inside is loaded
  await p.click("[data-testid=pick]");
  await p.waitForSelector(rowSel(0));
  check("opens Item.bmd from the folder", (await text(p, "[data-testid=result-count]")) === "488 rows" && (await text(p, "[data-testid=checksum]")) === "Checksum OK");
  check("path shows the folder", ((await p.getAttribute("span[dir=rtl]", "title")) ?? "") === "/Local/Item.bmd");

  // 3. Edit + save in place
  await p.click(rowSel(0));
  await p.keyboard.press("Enter");
  await p.waitForSelector("[data-testid=dialog]");
  await p.keyboard.type("Web Tester");
  await p.keyboard.press("Enter");
  await p.waitForSelector(EDITOR);
  await p.fill(EDITOR, "Chùy Trên Web");
  await p.keyboard.press("Enter");
  await p.waitForSelector(`${EDITOR}[aria-label="New name for 0:1"]`);
  await p.keyboard.press("Escape");
  await waitText(p, "[data-testid=dirty-status]", "● 1 unsaved change");
  await shot(p, "web-01-edit");
  await p.keyboard.press("Control+s");
  const saved = await toastWith(p, "Saved 1 change to Item.bmd.");
  check("save toast", saved.includes("/Local/Item.bmd.mubmd/backups/Item-"), saved);
  const onDisk = await opfsRead(p, "Local/Item.bmd");
  check("file written in place", onDisk !== null && ItemBmd.parse(onDisk).getName(0).text === "Chùy Trên Web" && ItemBmd.parse(onDisk).checksumValid);
  const side = await opfsList(p, "Local/Item.bmd.mubmd");
  check("side data next to the file", side.join(",") === "backups,changes.tsv,project.json", side.join(","));
  const backups = await opfsList(p, "Local/Item.bmd.mubmd/backups");
  const firstBackup = backups[0] ? await opfsRead(p, `Local/Item.bmd.mubmd/backups/${backups[0]}`) : null;
  check("backup is the original", backups.length === 1 && firstBackup !== null && Buffer.from(firstBackup).equals(Buffer.from(buildSampleBmd())));

  // 4. Undo / redo still work
  await p.focus("[data-testid=grid]");
  await p.keyboard.press("Control+z");
  await waitText(p, "[data-testid=dirty-status]", "● 1 unsaved change");
  await p.keyboard.press("Control+y");
  await waitText(p, "[data-testid=dirty-status]", "All saved");
  check("undo / redo", true);

  // 5. Draft survives closing the tab (= a new Session)
  await p.dblclick(rowSel(1));
  await p.fill(EDITOR, "Đoản Đao Nháp");
  await p.keyboard.press("Enter");
  await p.waitForSelector(`${EDITOR}[aria-label="New name for 0:2"]`);
  await p.keyboard.press("Escape");
  await waitText(p, "[data-testid=dirty-status]", "● 1 unsaved change");
  check("draft.json written", (await opfsList(p, "Local/Item.bmd.mubmd")).includes("draft.json"));
  lastDialog = "";
  await p.reload();
  check("warns before leaving with unsaved changes", lastDialog === "beforeunload", lastDialog);
  await p.click("[data-testid=pick]");
  await p.waitForSelector("[data-testid=dialog]");
  check("draft offered after reload", (await text(p, "[data-testid=dialog] h2")) === "Restore unsaved changes?");
  await p.click("[data-testid=dialog-restore]");
  await waitText(p, "[data-testid=dirty-status]", "● 1 unsaved change");
  check("draft restored", (await text(p, `[data-testid=grid] [data-slot='1'] > span:nth-child(3)`)) === "Đoản Đao Nháp");

  // 6. The file changes underneath (another program / Drive sync) -> conflict
  const other = ItemBmd.parse((await opfsRead(p, "Local/Item.bmd"))!);
  other.setName(5, "Sửa Từ Bên Ngoài");
  await opfsWrite(p, "Local/Item.bmd", other.toBytes());
  await p.keyboard.press("Control+s");
  await p.waitForSelector("[data-testid=dialog]");
  check("conflict detected", (await text(p, "[data-testid=dialog] h2")) === "The file was changed outside this tool");
  await shot(p, "web-02-conflict");
  await p.click("[data-testid=dialog-force]");
  await toastWith(p, "Saved 1 change");
  const forced = ItemBmd.parse((await opfsRead(p, "Local/Item.bmd"))!);
  check("overwrite after confirming", forced.getName(1).text === "Đoản Đao Nháp");

  // 7. Status + note persist in project.json
  await p.click(rowSel(3));
  await p.keyboard.press("Alt+Digit3");
  await waitText(p, "[data-testid=dirty-status]", "● 1 unsaved change");
  await p.keyboard.press("Control+s");
  await toastWith(p, "Saved 1 change");
  const project = JSON.parse(new TextDecoder().decode((await opfsRead(p, "Local/Item.bmd.mubmd/project.json"))!));
  check("status saved to project.json", project.records["3"]?.status === "reviewed");

  // 8. A folder without any .bmd -> translated error
  await p.click("[data-testid=open-other]");
  await pickNext(p, "Empty");
  await p.click("[data-testid=pick]");
  await p.waitForSelector("[data-testid=open-error]");
  check("folder without .bmd", (await text(p, "[data-testid=open-error]")) === "No .bmd file was found in the folder “Empty”.");

  // ---- W3: pickers, recent files, single file, save as, beforeunload, second tab ----
  const choose = async (trigger: string, option: string) => {
    await p.click(`[data-testid=${trigger}]`);
    await p.click(`[data-testid=${option}]`);
    await p.waitForFunction(() => !document.querySelector("[role=menu], [role=listbox]"));
  };
  const action = (id: string) => choose("actions", `action-${id}`);

  // 9. Recent files survive a reload (handle remembered in IndexedDB)
  await p.reload();
  const recent = await text(p, "[data-testid=recent]");
  check("recent entry shown without the id", recent === "/Local/Item.bmd", recent);
  await p.click("[data-testid=recent]");
  await p.waitForSelector(rowSel(0));
  check("reopened from the recent list", (await text(p, "[data-testid=dirty-status]")) === "All saved");

  // 10. Export TSV through the save picker
  await pickNext(p, "out/export.tsv");
  await action("export");
  await p.waitForSelector("[data-testid=export-dialog]");
  await p.click("[data-testid=export-named]");
  await p.click("[data-testid=export-go]");
  const exported = await toastWith(p, "Exported 488 rows to export.tsv.");
  const tsv = await opfsRead(p, "out/export.tsv");
  // TextDecoder drops the BOM, so check its bytes separately (EF BB BF = UTF-8 BOM for Excel).
  const hasBom = tsv !== null && tsv[0] === 0xef && tsv[1] === 0xbb && tsv[2] === 0xbf;
  check("export written through the save picker", hasBom && new TextDecoder().decode(tsv!).startsWith("ItemType\tItemIndex\tName"), exported);

  // 11. Reference file through the open picker
  await opfsWrite(p, "in/ref.tsv", new TextEncoder().encode("ItemType\tItemIndex\tName(Japanese)\n0\t0\tクリス\n"));
  await pickNext(p, "in/ref.tsv");
  await action("reference");
  const ref = await toastWith(p, "Reference: ref.tsv (1 names)");
  check("reference loaded", await p.isVisible("text=クリス"), ref);

  // 12. Import a teammate's TSV
  await opfsWrite(
    p,
    "in/theirs.tsv",
    new TextEncoder().encode("ItemType\tItemIndex\tName\tStatus\tTranslator\tBaseName\n0\t4\tĐao Sát Thủ Web\ttranslated\tBình\tĐao Sát Thủ\n"),
  );
  await pickNext(p, "in/theirs.tsv");
  await action("import");
  await p.waitForSelector("[data-testid=import-dialog]");
  check("import preview", (await text(p, "[data-testid=import-summary]")) === "1 to apply · 0 conflicts · 0 status changes · 0 invalid");
  await p.click("[data-testid=import-apply]");
  await toastWith(p, "Imported 1 change");
  check("import applied", (await text(p, `[data-testid=grid] [data-slot='4'] > span:nth-child(3)`)) === "Đao Sát Thủ Web");
  await choose("problem", "problem-any");

  // 13. Glossary: open the legacy CSV, save as TSV
  await opfsWrite(p, "in/glossary.csv", new TextEncoder().encode("Loại,Thuật ngữ / Mẫu,Ghi chú\nĐã chốt dịch,Defense -> Phòng Thủ,\n"));
  await action("glossary");
  await p.waitForSelector("[data-testid=glossary-dialog]");
  await pickNext(p, "in/glossary.csv");
  await p.click("[data-testid=glossary-open]");
  await toastWith(p, "Glossary: glossary.csv (1 terms)");
  await pickNext(p, "out/glossary.tsv");
  await p.click("[data-testid=glossary-save]");
  await toastWith(p, "Saved 1 terms to glossary.tsv.");
  const gl = await opfsRead(p, "out/glossary.tsv");
  check("glossary saved through the save picker", gl !== null && new TextDecoder().decode(gl).includes("Defense\tPhòng Thủ"));
  await p.keyboard.press("Escape");
  await p.waitForSelector("[data-testid=glossary-dialog]", { state: "detached" });

  // 14. Save as -> new file; its side data goes to OPFS side/<id>/
  await pickNext(p, "out/Item_copy.bmd");
  await p.click("text=Save as…");
  const savedAs = await toastWith(p, "to Item_copy.bmd.");
  const copy = await opfsRead(p, "out/Item_copy.bmd");
  check("save as writes the new file", copy !== null && ItemBmd.parse(copy).getName(4).text === "Đao Sát Thủ Web", savedAs);
  check("now editing the copy", ((await p.getAttribute("span[dir=rtl]", "title")) ?? "").endsWith("/Item_copy.bmd"));
  const sideIds = await opfsList(p, "side");
  const sideFiles = sideIds.length ? await opfsList(p, `side/${sideIds[sideIds.length - 1]}/Item_copy.bmd.mubmd`) : [];
  check("side data of a single file kept in the browser", sideFiles.includes("project.json"), `${sideIds} ${sideFiles}`);

  // 15. Open a single Item.bmd file (not a folder)
  await opfsWrite(p, "single/Item.bmd", buildSampleBmd());
  await p.click("[data-testid=open-other]");
  await pickNext(p, "single/Item.bmd");
  await p.click("[data-testid=pick-file]");
  await p.waitForSelector(rowSel(0));
  check("single file opened", ((await p.getAttribute("span[dir=rtl]", "title")) ?? "") === "/Item.bmd/Item.bmd");

  // 16. Closing the tab with unsaved changes asks first
  await p.dblclick(rowSel(2));
  await p.fill(EDITOR, "Trường Kiếm Chưa Lưu");
  await p.keyboard.press("Enter");
  await waitText(p, "[data-testid=dirty-status]", "● 1 unsaved change");
  await p.keyboard.press("Escape");
  lastDialog = "";
  await p.close({ runBeforeUnload: true });
  await Bun.sleep(500);
  check("warns before closing the tab with unsaved changes", lastDialog === "beforeunload", lastDialog);

  // 17. The same folder open in two tabs -> both are warned
  const a = await ctx.newPage();
  const b = await ctx.newPage();
  for (const tab of [a, b]) {
    await tab.goto(URL);
    await tab.click("[data-testid=pick]");
    await tab.waitForSelector(rowSel(0));
  }
  const warnA = await toastWith(a, "also open in another tab");
  const warnB = await toastWith(b, "also open in another tab");
  check("second tab warning in both tabs", warnA.startsWith("This file") && warnB.startsWith("This file"), `${warnA} | ${warnB}`);

  check("no JavaScript errors", errors.length === 0, errors.join(" | "));
}

const timer = setTimeout(() => {
  console.log("✗ timed out");
  process.exit(1);
}, 150_000);

try {
  await main();
} catch (e) {
  failures++;
  console.log(`✗ error: ${(e as Error).message}`);
} finally {
  clearTimeout(timer);
  await (browser as Browser | null)?.close();
  // Wait until the server has really exited, so a following run can take the port again.
  const server = vite as ReturnType<typeof Bun.spawn> | null;
  server?.kill();
  await server?.exited;
  console.log(`\nScreenshots: ${SHOTS}`);
  console.log(failures ? `${failures} check(s) failed` : "All checks passed");
  process.exit(failures ? 1 : 0);
}
