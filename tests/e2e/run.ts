// run.ts - Test end-to-end trên Chrome thật (headless) với BẢN SAO của data/Item.bmd.
//   bun run test:e2e [thư/mục/lưu/ảnh]
// Cần Google Chrome đã cài (playwright-core dùng channel "chrome", không tải trình duyệt).

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
  throw new Error("server không chạy");
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
// Chờ thông báo có chứa đoạn chữ; trả về "" nếu không thấy (để check() báo lỗi rõ ràng).
async function toastWith(p: Page, needle: string): Promise<string> {
  const t = p.locator("[data-sonner-toast]", { hasText: needle }).first();
  try {
    await t.waitFor();
    return ((await t.textContent()) ?? "").trim();
  } catch {
    const all = await p.locator("[data-sonner-toast]").allTextContents();
    return `(không thấy; đang có: ${all.join(" | ") || "không có thông báo nào"})`;
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

  // 1. Lần đầu: luôn tiếng Anh
  await p.goto(URL);
  await p.waitForSelector(rowSel(0));
  check("lần đầu hiện tiếng Anh", (await p.getAttribute("html", "lang")) === "en" && (await text(p, "[data-testid=result-count]")) === "488 rows");

  // 2. Enter -> hỏi tên người dịch; Enter trong ô nhập = nút chính
  await p.click(rowSel(0));
  await p.keyboard.press("Enter");
  await p.waitForSelector("[data-testid=dialog]");
  check("hộp thoại người dịch (EN)", (await text(p, "[data-testid=dialog] h2")) === "Translator name");
  await p.keyboard.type("Tester");
  await p.keyboard.press("Enter");
  await p.waitForSelector(EDITOR);
  check("Enter trong hộp thoại lưu tên người dịch", (await text(p, "[data-testid=translator]")) === "Translator: Tester");
  await shot(p, "01-editor-en");

  // 3. Tên quá dài
  await p.fill(EDITOR, "Quyền Trượng Đại Vương Huyền Thoại Cổ Xưa");
  check("bộ đếm byte", (await text(p, "[data-testid=editor-counter]")) === "58/49");
  await p.keyboard.press("Enter");
  const tooLong = await toastWith(p, "over the 49-byte limit");
  check("tên quá dài bị chặn, ô sửa vẫn mở", (await p.isVisible(EDITOR)) && tooLong.includes("58 bytes"), tooLong);
  await shot(p, "02-too-long-en");

  // 4. Bộ gõ tiếng Việt: Enter lúc đang ghép chữ không được lưu
  await p.fill(EDITOR, "Chùy Thử");
  await p.$eval(EDITOR, (el) =>
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true, cancelable: true })),
  );
  await p.waitForTimeout(150);
  check("Enter khi đang ghép chữ (IME) bị bỏ qua", (await p.isVisible(EDITOR)) && (await p.inputValue(EDITOR)) === "Chùy Thử");

  // 5. Enter -> lưu, sang dòng dưới
  await p.fill(EDITOR, "Chùy Thử Nghiệm");
  await p.keyboard.press("Enter");
  await p.waitForSelector(`${EDITOR}[aria-label="New name for 0:1"]`);
  check("Enter lưu và sang dòng dưới", true);
  await p.fill(EDITOR, "Đoản Đao Mới");
  await p.keyboard.press("Enter");
  await p.waitForSelector(`${EDITOR}[aria-label="New name for 0:2"]`);
  await p.keyboard.press("Escape");
  check("2 thay đổi chưa lưu", (await text(p, "[data-testid=dirty-status]")) === "● 2 unsaved changes");
  await p.click(rowSel(0));
  await shot(p, "03-dirty-en");

  // 6. Undo / redo
  await p.focus("[data-testid=grid]");
  await p.keyboard.press("Control+z");
  await p.waitForFunction(() => document.querySelector("[data-testid=dirty-status]")?.textContent?.includes("1 unsaved change"));
  await p.keyboard.press("Control+y");
  await p.waitForFunction(() => document.querySelector("[data-testid=dirty-status]")?.textContent?.includes("2 unsaved"));
  check("undo / redo", true);

  // 7. Lưu
  await p.keyboard.press("Control+s");
  const saved = await toastWith(p, "Saved 2 changes to Item.bmd.");
  check("lưu + thông báo EN", saved.includes("backed up to"), saved);
  check("ghi đúng vào file", diskName(0) === "Chùy Thử Nghiệm" && diskName(1) === "Đoản Đao Mới");
  check("có backup + nhật ký", fs.existsSync(`${FILE}.mubmd/changes.tsv`) && fs.readdirSync(`${FILE}.mubmd/backups`).length === 1);

  // 8. Đổi sang tiếng Việt, tải lại trang vẫn giữ
  await p.click("[data-testid=lang-switch]");
  await p.click("[data-testid=lang-vi]");
  await p.waitForFunction(() => document.documentElement.lang === "vi");
  check("chuyển tiếng Việt", (await text(p, "[data-testid=result-count]")) === "488 dòng" && (await text(p, "[data-testid=dirty-status]")) === "Đã lưu hết");
  await p.reload();
  await p.waitForSelector(rowSel(0));
  check("tải lại vẫn giữ tiếng Việt", (await p.getAttribute("html", "lang")) === "vi");

  // 9. Nhấp đúp để sửa + xung đột khi file bị đổi bên ngoài
  await p.dblclick(rowSel(2));
  await p.waitForSelector(EDITOR);
  check("nhấp đúp mở ô sửa", true);
  await p.fill(EDITOR, "Trường Kiếm Mới");
  await p.keyboard.press("Enter");
  await p.waitForTimeout(200);
  await p.keyboard.press("Escape");
  const other = ItemBmd.parse(new Uint8Array(fs.readFileSync(FILE)));
  other.setName(10, "Người Khác Sửa");
  fs.writeFileSync(FILE, other.toBytes());
  await p.keyboard.press("Control+s");
  await p.waitForSelector("[data-testid=dialog]");
  check("hộp thoại xung đột (VI)", (await text(p, "[data-testid=dialog] h2")) === "File đã bị thay đổi bên ngoài");
  await shot(p, "04-conflict-vi");
  await p.click("[data-testid=dialog-force]");
  const forced = await toastWith(p, "Đã lưu 1 thay đổi");
  check("ghi đè + thông báo VI", forced.includes("Bản cũ đã được backup") && diskName(2) === "Trường Kiếm Mới", forced);

  // 10. Bản nháp sau khi tắt server
  await p.dblclick(rowSel(3));
  await p.fill(EDITOR, "Kiếm Nháp");
  await p.keyboard.press("Enter");
  await p.waitForTimeout(200);
  await p.keyboard.press("Escape");
  await stopServer();
  await startServer();
  await p.reload();
  await p.waitForSelector("[data-testid=dialog]");
  check("hỏi khôi phục nháp (VI)", (await text(p, "[data-testid=dialog] h2")) === "Khôi phục thay đổi chưa lưu?");
  await shot(p, "05-draft-vi");
  await p.click("[data-testid=dialog-restore]");
  const restored = await toastWith(p, "Đã khôi phục 1 thay đổi");
  check("khôi phục nháp", (await text(p, "[data-testid=dirty-status]")) === "● 1 thay đổi chưa lưu", restored);

  // 11. Bộ lọc "Đã sửa"
  await p.click("[data-testid=problem]");
  await p.click("[data-testid=problem-edited]");
  await p.waitForFunction(() => document.querySelector("[data-testid=result-count]")?.textContent?.trim() === "1 dòng");
  check("bộ lọc Đã sửa", true);
  await p.click(rowSel(0));
  await shot(p, "06-edited-filter-vi");

  // 12. Lỗi mở file được dịch; mở file khác khi còn thay đổi -> xác nhận bỏ
  await p.click("[data-testid=open-other]");
  await p.fill("#open-path", path.join(WORK, "khong-co.bmd"));
  await p.keyboard.press("Enter");
  await p.waitForSelector("[data-testid=open-error]");
  check("lỗi mở file bằng tiếng Việt", (await text(p, "[data-testid=open-error]")) === "Không tìm thấy file.");
  await p.fill("#open-path", FILE);
  await p.keyboard.press("Enter");
  await p.waitForSelector("[data-testid=dialog]");
  check("hỏi bỏ thay đổi khi mở lại", (await text(p, "[data-testid=dialog] h2")) === "Bỏ thay đổi chưa lưu?");
  await p.click("[data-testid=dialog-discard]");
  // Bộ lọc vẫn là "Đã sửa" nên danh sách trống là đúng; chỉ cần trạng thái về "Đã lưu hết".
  await p.waitForFunction(() => document.querySelector("[data-testid=dirty-status]")?.textContent?.trim() === "Đã lưu hết");
  check("đã bỏ thay đổi", (await text(p, "[data-testid=result-count]")) === "0 dòng");

  // 13. Giao diện tối + màn hình hẹp (ngữ cảnh mới = lần đầu -> tiếng Anh)
  const dark = await browser.newPage({ viewport: { width: 1440, height: 860 }, colorScheme: "dark" });
  await dark.goto(URL);
  await dark.waitForSelector(rowSel(0));
  await dark.click(rowSel(4));
  await shot(dark, "07-dark-en");
  const narrow = await browser.newPage({ viewport: { width: 420, height: 820 } });
  await narrow.goto(URL);
  await narrow.waitForSelector(rowSel(0));
  await shot(narrow, "08-narrow-en");

  check("không có lỗi JavaScript", errors.length === 0, errors.join(" | "));
}

const timer = setTimeout(() => {
  console.log("✗ quá thời gian");
  process.exit(1);
}, 150_000);

try {
  await main();
} catch (e) {
  failures++;
  console.log(`✗ lỗi: ${(e as Error).message}`);
} finally {
  clearTimeout(timer);
  await (browser as Browser | null)?.close(); // gán trong main() nên TS tưởng luôn null
  await stopServer();
  console.log(`\nẢnh chụp: ${SHOTS}`);
  console.log(failures ? `${failures} kiểm tra thất bại` : "Tất cả kiểm tra đều qua");
  process.exit(failures ? 1 : 0);
}
