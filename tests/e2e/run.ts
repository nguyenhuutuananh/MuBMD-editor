// run.ts - End-to-end test in real (headless) Chrome against a COPY of data/Item.bmd.
//   bun run test:e2e [screenshot/dir]
// Requires an installed Google Chrome (playwright-core uses the "chrome" channel, no browser download).

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type Browser, type Page, chromium } from "playwright-core";
import { ItemBmd } from "../../src/core";

const ROOT = path.join(import.meta.dir, "../..");
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "mubmd-e2e-"));
const SHOTS = process.argv[2] ?? path.join(WORK, "shots");
const FILE = path.join(WORK, "Item.bmd");
const PORT = 4851;
const URL = `http://localhost:${PORT}/`;
fs.mkdirSync(SHOTS, { recursive: true });
fs.copyFileSync(path.join(ROOT, "data/Item.bmd"), FILE);

let server: ReturnType<typeof Bun.spawn> | null = null;
let browser: Browser | null = null;
let failures = 0;

async function startServer() {
  server = Bun.spawn(["bun", path.join(ROOT, "src/server/main.ts"), FILE, "--no-open", "--port", String(PORT)], {
    stdout: "ignore",
    stderr: "ignore",
  });
  for (let i = 0; i < 60; i++) {
    try {
      await fetch(`${URL}api/state`);
      return;
    } catch {
      await Bun.sleep(100);
    }
  }
  throw new Error("server did not start");
}

async function stopServer() {
  server?.kill();
  await server?.exited;
  server = null;
}

function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures++;
}

const diskName = (slot: number) => ItemBmd.parse(new Uint8Array(fs.readFileSync(FILE))).getName(slot).text;
const rowSel = (n: number) => `[data-testid=grid] [data-slot] >> nth=${n}`;
const EDITOR = "[data-testid=inline-editor] input";
const text = async (p: Page, sel: string) => ((await p.textContent(sel)) ?? "").trim();
// Wait for a toast containing the text; returns a diagnostic string if none appears (so check() reports clearly).
async function toastWith(p: Page, needle: string): Promise<string> {
  const t = p.locator("[data-sonner-toast]", { hasText: needle }).first();
  try {
    await t.waitFor();
    return ((await t.textContent()) ?? "").trim();
  } catch {
    const all = await p.locator("[data-sonner-toast]").allTextContents();
    return `(not found; showing: ${all.join(" | ") || "no toasts"})`;
  }
}
const shot = (p: Page, name: string) => p.screenshot({ path: path.join(SHOTS, `${name}.png`) });

async function main() {
  await startServer();
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const p = await browser.newPage({ viewport: { width: 1440, height: 860 } });
  p.setDefaultTimeout(8000);
  const errors: string[] = [];
  p.on("pageerror", (e) => errors.push(String(e)));

  // 1. First launch: always English
  await p.goto(URL);
  await p.waitForSelector(rowSel(0));
  check("first launch shows English", (await p.getAttribute("html", "lang")) === "en" && (await text(p, "[data-testid=result-count]")) === "488 rows");

  // 2. Enter -> asks for translator name; Enter in the input = primary button
  await p.click(rowSel(0));
  await p.keyboard.press("Enter");
  await p.waitForSelector("[data-testid=dialog]");
  check("translator dialog (EN)", (await text(p, "[data-testid=dialog] h2")) === "Translator name");
  await p.keyboard.type("Tester");
  await p.keyboard.press("Enter");
  await p.waitForSelector(EDITOR);
  check("Enter in the dialog saves the translator name", (await text(p, "[data-testid=translator]")) === "Translator: Tester");
  await shot(p, "01-editor-en");

  // 3. Over-long name
  await p.fill(EDITOR, "Quyền Trượng Đại Vương Huyền Thoại Cổ Xưa");
  check("byte counter", (await text(p, "[data-testid=editor-counter]")) === "58/49");
  await p.keyboard.press("Enter");
  const tooLong = await toastWith(p, "over the 49-byte limit");
  check("over-long name is blocked, editor stays open", (await p.isVisible(EDITOR)) && tooLong.includes("58 bytes"), tooLong);
  await shot(p, "02-too-long-en");

  // 4. Vietnamese IME: Enter during composition must not save
  await p.fill(EDITOR, "Chùy Thử");
  await p.$eval(EDITOR, (el) =>
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true, cancelable: true })),
  );
  await p.waitForTimeout(150);
  check("Enter during IME composition is ignored", (await p.isVisible(EDITOR)) && (await p.inputValue(EDITOR)) === "Chùy Thử");

  // 5. Enter -> save, move to the next row
  await p.fill(EDITOR, "Chùy Thử Nghiệm");
  await p.keyboard.press("Enter");
  await p.waitForSelector(`${EDITOR}[aria-label="New name for 0:1"]`);
  check("Enter saves and moves to the next row", true);
  await p.fill(EDITOR, "Đoản Đao Mới");
  await p.keyboard.press("Enter");
  await p.waitForSelector(`${EDITOR}[aria-label="New name for 0:2"]`);
  await p.keyboard.press("Escape");
  check("2 unsaved changes", (await text(p, "[data-testid=dirty-status]")) === "● 2 unsaved changes");
  await p.click(rowSel(0));
  await shot(p, "03-dirty-en");

  // 6. Undo / redo
  await p.focus("[data-testid=grid]");
  await p.keyboard.press("Control+z");
  await p.waitForFunction(() => document.querySelector("[data-testid=dirty-status]")?.textContent?.includes("1 unsaved change"));
  await p.keyboard.press("Control+y");
  await p.waitForFunction(() => document.querySelector("[data-testid=dirty-status]")?.textContent?.includes("2 unsaved"));
  check("undo / redo", true);

  // 7. Save
  await p.keyboard.press("Control+s");
  const saved = await toastWith(p, "Saved 2 changes to Item.bmd.");
  check("save + EN toast", saved.includes("backed up to"), saved);
  check("written correctly to the file", diskName(0) === "Chùy Thử Nghiệm" && diskName(1) === "Đoản Đao Mới");
  check("backup + change log exist", fs.existsSync(`${FILE}.mubmd/changes.tsv`) && fs.readdirSync(`${FILE}.mubmd/backups`).length === 1);

  // 8. Switch to Vietnamese; it persists across reload
  await p.click("[data-testid=lang-switch]");
  await p.click("[data-testid=lang-vi]");
  await p.waitForFunction(() => document.documentElement.lang === "vi");
  check("switched to Vietnamese", (await text(p, "[data-testid=result-count]")) === "488 dòng" && (await text(p, "[data-testid=dirty-status]")) === "Đã lưu hết");
  await p.reload();
  await p.waitForSelector(rowSel(0));
  check("Vietnamese kept after reload", (await p.getAttribute("html", "lang")) === "vi");

  // 9. Double-click to edit + conflict when the file changes externally
  await p.dblclick(rowSel(2));
  await p.waitForSelector(EDITOR);
  check("double-click opens the editor", true);
  await p.fill(EDITOR, "Trường Kiếm Mới");
  await p.keyboard.press("Enter");
  await p.waitForTimeout(200);
  await p.keyboard.press("Escape");
  const other = ItemBmd.parse(new Uint8Array(fs.readFileSync(FILE)));
  other.setName(10, "Người Khác Sửa");
  fs.writeFileSync(FILE, other.toBytes());
  await p.keyboard.press("Control+s");
  await p.waitForSelector("[data-testid=dialog]");
  check("conflict dialog (VI)", (await text(p, "[data-testid=dialog] h2")) === "File đã bị thay đổi bên ngoài");
  await shot(p, "04-conflict-vi");
  await p.click("[data-testid=dialog-force]");
  const forced = await toastWith(p, "Đã lưu 1 thay đổi");
  check("overwrite + VI toast", forced.includes("Bản cũ đã được backup") && diskName(2) === "Trường Kiếm Mới", forced);

  // 10. Draft after the server is killed
  await p.dblclick(rowSel(3));
  await p.fill(EDITOR, "Kiếm Nháp");
  await p.keyboard.press("Enter");
  await p.waitForTimeout(200);
  await p.keyboard.press("Escape");
  await stopServer();
  await startServer();
  await p.reload();
  await p.waitForSelector("[data-testid=dialog]");
  check("asks to restore the draft (VI)", (await text(p, "[data-testid=dialog] h2")) === "Khôi phục thay đổi chưa lưu?");
  await shot(p, "05-draft-vi");
  await p.click("[data-testid=dialog-restore]");
  const restored = await toastWith(p, "Đã khôi phục 1 thay đổi");
  check("draft restored", (await text(p, "[data-testid=dirty-status]")) === "● 1 thay đổi chưa lưu", restored);

  // 11. "Edited" filter
  await p.click("[data-testid=problem]");
  await p.click("[data-testid=problem-edited]");
  await p.waitForFunction(() => document.querySelector("[data-testid=result-count]")?.textContent?.trim() === "1 dòng");
  check("Edited filter", true);
  await p.click(rowSel(0));
  await shot(p, "06-edited-filter-vi");

  // 12. Open errors are translated; opening a file with unsaved changes -> confirm discard
  await p.click("[data-testid=open-other]");
  await p.fill("#open-path", path.join(WORK, "khong-co.bmd"));
  await p.keyboard.press("Enter");
  await p.waitForSelector("[data-testid=open-error]");
  check("open error in Vietnamese", (await text(p, "[data-testid=open-error]")) === "Không tìm thấy file.");
  await p.fill("#open-path", FILE);
  await p.keyboard.press("Enter");
  await p.waitForSelector("[data-testid=dialog]");
  check("asks to discard changes when reopening", (await text(p, "[data-testid=dialog] h2")) === "Bỏ thay đổi chưa lưu?");
  await p.click("[data-testid=dialog-discard]");
  // The filter is still "Edited", so an empty list is correct; just wait for the all-saved status.
  await p.waitForFunction(() => document.querySelector("[data-testid=dirty-status]")?.textContent?.trim() === "Đã lưu hết");
  check("changes discarded", (await text(p, "[data-testid=result-count]")) === "0 dòng");

  // 13. Dark theme + narrow screen (new context = first launch -> English)
  const dark = await browser.newPage({ viewport: { width: 1440, height: 860 }, colorScheme: "dark" });
  await dark.goto(URL);
  await dark.waitForSelector(rowSel(0));
  await dark.click(rowSel(4));
  await shot(dark, "07-dark-en");
  const narrow = await browser.newPage({ viewport: { width: 420, height: 820 } });
  await narrow.goto(URL);
  await narrow.waitForSelector(rowSel(0));
  await shot(narrow, "08-narrow-en");

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
  await (browser as Browser | null)?.close(); // assigned inside main(), so TS narrows it to null
  await stopServer();
  console.log(`\nScreenshots: ${SHOTS}`);
  console.log(failures ? `${failures} check(s) failed` : "All checks passed");
  process.exit(failures ? 1 : 0);
}
