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
let mainPage: Page | null = null; // screenshot on failure

// Native file dialogs are answered from this queue (see MUBMD_FAKE_PICK in src/server/main.ts).
const PICK = path.join(WORK, "pick.json");
const setPick = (...paths: (string | null)[]) => fs.writeFileSync(PICK, JSON.stringify(paths));
setPick();

async function startServer() {
  server = Bun.spawn(["bun", path.join(ROOT, "src/server/main.ts"), FILE, "--no-open", "--port", String(PORT)], {
    stdout: "ignore",
    stderr: "ignore",
    env: { ...process.env, MUBMD_FAKE_PICK: PICK },
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
  mainPage = p;
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

  // 14. Phase 4: status, note, bulk mark, reference, export, import (3-way merge)
  const choose = async (trigger: string, option: string) => {
    await p.click(`[data-testid=${trigger}]`);
    await p.click(`[data-testid=${option}]`);
  };
  const action = (id: string) => choose("actions", `action-${id}`);
  const statusOf = (slot: number) => p.getAttribute(`[data-testid=grid] [data-slot='${slot}'] [data-status]`, "data-status");
  await choose("problem", "problem-any");
  await p.waitForFunction(() => document.querySelector("[data-testid=result-count]")?.textContent?.trim() === "488 dòng");

  await p.click(rowSel(5));
  await p.keyboard.press("Alt+Digit2");
  await p.waitForFunction(() => document.querySelector("[data-testid=dirty-status]")?.textContent?.includes("1 thay đổi"));
  check("Alt+2 marks the row translated", (await statusOf(5)) === "translated");
  await p.click("[data-testid=detail-status-reviewed]");
  await p.fill("[data-testid=detail-note]", "kiểm tra lại");
  await p.keyboard.press("Enter");
  await p.waitForFunction(() => document.querySelector("[data-testid=grid] [data-slot='5']")?.textContent?.includes("kiểm tra lại"));
  check("detail status + note", (await statusOf(5)) === "reviewed");

  await p.fill("[data-testid=search]", "rong do");
  await p.keyboard.press("Enter");
  await p.waitForFunction(() => document.querySelector("[data-testid=result-count]")?.textContent?.trim() === "10 dòng");
  await choose("actions", "mark-reviewed");
  const marked = await toastWith(p, "Đã đánh dấu 10 dòng");
  check("bulk mark the listed rows", marked.includes("Đã duyệt"), marked);
  await p.fill("[data-testid=search]", "");
  await p.keyboard.press("Enter");

  await p.keyboard.press("Control+s");
  await toastWith(p, "Đã lưu 11 thay đổi");
  const project = JSON.parse(fs.readFileSync(`${FILE}.mubmd/project.json`, "utf-8"));
  check("status-only save writes project.json", project.records["5"]?.status === "reviewed" && project.records["5"]?.note === "kiểm tra lại");

  const ref = path.join(WORK, "ref.tsv");
  fs.writeFileSync(ref, "ItemType\tItemIndex\tName(Japanese)\n0\t0\tクリス\n0\t1\tダガー\n");
  setPick(ref);
  await action("reference");
  const refToast = await toastWith(p, "Tham chiếu: ref.tsv");
  check("reference file loaded", refToast.includes("2 tên") && (await p.isVisible("text=クリス")), refToast);
  await p.fill("[data-testid=search]", "dagaa");
  await p.fill("[data-testid=search]", "ダガー");
  await p.keyboard.press("Enter");
  await p.waitForFunction(() => document.querySelector("[data-testid=result-count]")?.textContent?.trim() === "1 dòng");
  check("search matches reference names", true);
  await p.fill("[data-testid=search]", "");
  await p.keyboard.press("Enter");
  await shot(p, "09-status-reference-vi");

  const exported = path.join(WORK, "export.tsv");
  setPick(exported);
  await action("export");
  await p.waitForSelector("[data-testid=export-dialog]");
  await p.click("[data-testid=export-named]");
  await shot(p, "10-export-vi");
  await p.click("[data-testid=export-go]");
  const exp = await toastWith(p, "Đã xuất");
  const expText = fs.existsSync(exported) ? fs.readFileSync(exported, "utf-8") : "";
  check(
    "export all named slots",
    exp.includes("488 dòng") && expText.startsWith("\uFEFFItemType\tItemIndex\tName\tStatus") && expText.includes("\tクリス\t"),
    exp,
  );

  // Another translator's file: 0:4 changed only by them, 0:6 changed on both sides, 0:7 too long.
  await p.dblclick(rowSel(6));
  await p.fill(EDITOR, "Kiếm La Mã Của Mình");
  await p.keyboard.press("Enter");
  await p.waitForTimeout(200);
  await p.keyboard.press("Escape");
  const theirs = path.join(WORK, "theirs.tsv");
  fs.writeFileSync(
    theirs,
    [
      "ItemType\tItemIndex\tName\tStatus\tTranslator\tBaseName",
      "0\t4\tĐao Sát Thủ Mới\ttranslated\tBình\tĐao Sát Thủ",
      "0\t6\tKiếm La Mã Của Họ\ttranslated\tBình\tKiếm La mã",
      `0\t7\t${"Đ".repeat(30)}\ttranslated\tBình\tMã Tấu`,
      "0\t8\tXà Đao\ttranslated\tBình\tXà Đao",
    ].join("\n"),
  );
  setPick(theirs);
  await action("import");
  await p.waitForSelector("[data-testid=import-dialog]");
  const summary = await text(p, "[data-testid=import-summary]");
  check("import preview summary", summary === "1 thay đổi · 1 xung đột · 1 đổi trạng thái · 1 không hợp lệ", summary);
  const conflictBox = p.locator("[data-testid=import-dialog] tr[data-kind=conflict] input");
  check("conflict unchecked by default", !(await conflictBox.isChecked()));
  await shot(p, "11-import-vi");
  await p.click("[data-testid=import-apply]");
  const imported = await toastWith(p, "Đã nhập 2 thay đổi");
  check("import applies only the chosen rows", imported.length > 0, imported);
  const nameOf = async (slot: number) => text(p, `[data-testid=grid] [data-slot='${slot}'] > span:nth-child(3)`);
  check("their change applied, my conflicting edit kept", (await nameOf(4)) === "Đao Sát Thủ Mới" && (await nameOf(6)) === "Kiếm La Mã Của Mình");
  await choose("problem", "problem-any");
  await p.focus("[data-testid=grid]");
  await p.keyboard.press("Control+z");
  await p.waitForFunction(() => document.querySelector("[data-testid=grid] [data-slot='4']")?.textContent?.includes("Đao Sát Thủ") && !document.querySelector("[data-testid=grid] [data-slot='4']")?.textContent?.includes("Mới"));
  check("the whole import is one undo step", (await nameOf(6)) === "Kiếm La Mã Của Mình");

  // 15. Phase 5: glossary (legacy CSV -> TSV), glossary mismatch filter, compare with another Item.bmd
  const legacyCsv = path.join(WORK, "glossary.csv");
  fs.writeFileSync(legacyCsv, "Loại,Thuật ngữ / Mẫu,Ghi chú\nĐã chốt dịch,Defense -> Phòng Thủ,PT\nGiữ nguyên,\"Lorencia, Devias\",\n");
  setPick(legacyCsv);
  await action("glossary");
  await p.waitForSelector("[data-testid=glossary-dialog]");
  await p.click("[data-testid=glossary-open]");
  await toastWith(p, "Thuật ngữ: glossary.csv (3 thuật ngữ)");
  check("legacy glossary CSV loaded", (await p.locator("[data-testid=glossary-row]").count()) === 3);
  await p.fill("[data-testid=glossary-term]", "Helm");
  await p.fill("[data-testid=glossary-translation]", "Mũ");
  await p.click("[data-testid=glossary-add]");
  await shot(p, "12-glossary-vi");
  const glossTsv = path.join(WORK, "glossary.tsv");
  setPick(glossTsv);
  await p.click("[data-testid=glossary-save]");
  await toastWith(p, "Đã lưu 4 thuật ngữ vào glossary.tsv");
  check("glossary saved as TSV", fs.existsSync(glossTsv) && fs.readFileSync(glossTsv, "utf-8").includes("Helm\tMũ"));
  await p.keyboard.press("Escape");
  await p.waitForSelector("[data-testid=glossary-dialog]", { state: "detached" });

  await p.dblclick(rowSel(3));
  await p.fill(EDITOR, "Kiếm Helm");
  await p.keyboard.press("Enter");
  await p.waitForTimeout(200);
  await p.keyboard.press("Escape");
  await choose("problem", "problem-glossary");
  await p.waitForFunction(() => document.querySelector("[data-testid=result-count]")?.textContent?.trim() === "1 dòng");
  await p.click(rowSel(0));
  const hint = await text(p, "[data-testid=glossary-hints]");
  check("glossary mismatch filter + hint", hint.includes("“Helm” vẫn chưa dịch (→ Mũ)"), hint);
  await shot(p, "13-glossary-hint-vi");
  await choose("problem", "problem-any");

  const otherBmd = ItemBmd.parse(new Uint8Array(fs.readFileSync(FILE)));
  otherBmd.setName(10, "Kiếm Ánh Sáng Khác");
  const otherFile = path.join(WORK, "Other.bmd");
  fs.writeFileSync(otherFile, otherBmd.toBytes());
  setPick(otherFile);
  await action("compare");
  await p.waitForSelector("[data-testid=import-dialog]");
  const title = await text(p, "[data-testid=import-dialog] h2");
  const rowsListed = await p.locator("[data-testid=import-dialog] tbody tr").count();
  check("compare dialog lists the differing names", title === "So sánh với Other.bmd" && rowsListed >= 1, `${title}, ${rowsListed} rows`);
  await shot(p, "14-compare-vi");
  await p.keyboard.press("Escape");

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
  await (mainPage as Page | null)?.screenshot({ path: path.join(SHOTS, "failure.png") }).catch(() => undefined);
} finally {
  clearTimeout(timer);
  await (browser as Browser | null)?.close(); // assigned inside main(), so TS narrows it to null
  await stopServer();
  console.log(`\nScreenshots: ${SHOTS}`);
  console.log(failures ? `${failures} check(s) failed` : "All checks passed");
  process.exit(failures ? 1 : 0);
}
