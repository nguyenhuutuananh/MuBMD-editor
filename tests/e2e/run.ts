// run.ts - End-to-end check of the desktop build: the real server + the built UI in headless
// Chromium, on the sample folder (always) and on a real checkout when MUMAIN_DIR is set (screenshots).
//   bun run test:e2e          (builds the UI first)
// Screenshots go to e2e-shots/.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { chromium, type Page } from "playwright-core";
import { ItemData } from "../../src/core";
import { writeSampleLocalization } from "../fixtures/sampleLocalization";
import { writeSampleCheckout } from "../fixtures/sampleWorkspace";
import { chromiumOptions } from "./browsers";

const root = path.join(import.meta.dir, "../..");
const shots = path.join(root, "e2e-shots");
fs.mkdirSync(shots, { recursive: true });

const sample = fs.mkdtempSync(path.join(os.tmpdir(), "mumain-translator-e2e-"));
writeSampleLocalization(sample);
// A MuMain checkout with both sources: src/Localization + src/bin/Data/Items.
const checkout = writeSampleCheckout(fs.mkdtempSync(path.join(os.tmpdir(), "mumain-translator-e2e-checkout-")));
const pickFile = path.join(sample, "..", `${path.basename(sample)}-pick.json`);
fs.writeFileSync(pickFile, JSON.stringify([sample]));

const PORT = 4899;
const server = Bun.spawn(["bun", "src/server/main.ts", "--no-open", "--port", String(PORT)], {
  cwd: root,
  env: { ...process.env, MUMAIN_TR_FAKE_PICK: pickFile },
  stdout: "pipe",
  stderr: "inherit",
});
const url = `http://localhost:${PORT}/`;
for (let i = 0; i < 100; i++) {
  try {
    if ((await fetch(`${url}api/state`)).ok) break;
  } catch {
    await Bun.sleep(100);
  }
}

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || !detail ? "" : ` - ${detail}`}`);
  if (!ok) failures++;
}

const browser = await chromium.launch(chromiumOptions());
const page: Page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on("pageerror", (e) => check("no page error", false, e.message));
const tid = (id: string) => page.getByTestId(id);
const text = async (id: string) => (await tid(id).textContent())?.trim() ?? "";
// Pick an option of a select; a select left open by an earlier key press is closed first.
async function choose(trigger: string, option: string) {
  if ((await tid(trigger).getAttribute("aria-expanded")) === "true") await page.keyboard.press("Escape");
  await tid(trigger).click();
  await tid(option).click();
}

try {
  // --- sample folder: pick (fake dialog) -> choose vi + de -> open
  await page.goto(url);
  await tid("pick").click();
  await tid("locale-vi").waitFor();
  check("locales listed without en", (await page.locator('[data-testid^="locale-"]:not([data-testid^="locale-new"])').count()) === 2);
  await tid("open").click();
  await tid("grid").waitFor();
  check("workspace shows the locale", (await text("locale")).startsWith("vi"));
  check("all rows listed", (await text("result-count")) === "18 rows", await text("result-count"));

  await tid("group-2").click(); // Game
  await choose("severity-filter", "severity-error");
  check("error filter", (await text("result-count")) === "1 row", await text("result-count"));
  await page.locator("[data-row]").first().click();
  const issues = await text("detail-issues");
  check("detail shows the printf problem", issues.includes("expected %s %d, found %d %s"), issues);
  await page.screenshot({ path: path.join(shots, "sample-error.png") });

  await choose("severity-filter", "severity-any");
  await tid("search").fill("#5");
  await page.keyboard.press("Enter");
  const value = await text("detail-value");
  check("legacy id search + stray backslash marked", value.includes("\\") && value.includes("⏎"), value);

  // interface language
  await tid("lang-switch").click();
  await tid("lang-vi").click();
  check("Vietnamese UI", (await text("result-count")) === "1 dòng", await text("result-count"));
  await tid("lang-switch").click();
  await tid("lang-en").click();

  // reference column
  await tid("search").fill("");
  await page.keyboard.press("Enter");
  await tid("reference").click();
  await page.getByRole("option", { name: /^de/ }).click();
  await page.waitForTimeout(200);
  check("reference column", (await tid("grid").textContent())?.includes("Ereignis") === true);

  // --- editing (sample folder only: the real MuMain files are never written by this test)
  const gameVi = () => fs.readFileSync(path.join(sample, "Game.vi.resx"), "utf-8");
  const find = async (q: string) => {
    await tid("search").fill(q);
    await page.keyboard.press("Enter"); // selects the first row and focuses the grid
  };
  page.on("dialog", (d) => d.accept()); // beforeunload on reload

  await find("Level %d");
  await page.keyboard.press("Enter"); // edit -> asks the translator's name first
  await tid("dialog").waitFor();
  await page.locator("#dialog-input").fill("E2E");
  await tid("dialog-ok").click();
  await tid("inline-editor").waitFor();
  await page.keyboard.type("Cấp");
  check("live check while typing", (await text("detail-issues")).includes("expected %d"), await text("detail-issues"));
  await page.keyboard.type(" %d");
  check("live check clears", (await tid("detail-issues").count()) === 0);
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector('[data-testid="dirty-status"]')?.textContent?.includes("1"));
  check("one unsaved change", (await text("dirty-status")).startsWith("● 1"), await text("dirty-status"));
  check("nothing written before saving", !gameVi().includes("Cấp %d"));
  await page.keyboard.press("Control+s");
  await page.waitForFunction(() => document.querySelector('[data-testid="dirty-status"]')?.textContent === "All saved");
  check("saved to Game.vi.resx with its legacy_id", /<value>Cấp %d<\/value>\n    <comment>legacy_id=11<\/comment>/.test(gameVi()));
  check("backup written", fs.readdirSync(path.join(sample, ".mumain-translator", "backups")).length === 1);

  await find("Chaos Castle");
  await tid("action-keep").click();
  await page.waitForTimeout(150);
  check("keep: state shown", (await tid("detail").textContent())?.includes("Kept in English") === true);
  await tid("save").click();
  await page.waitForFunction(() => document.querySelector('[data-testid="dirty-status"]')?.textContent === "All saved");
  check("keep mark written in the comment", gameVi().includes("<comment>legacy_id=12; keep</comment>"));

  await tid("undo").click();
  await page.waitForTimeout(150);
  check("undo after save = unsaved change", (await text("dirty-status")).startsWith("● 1"), await text("dirty-status"));
  await tid("redo").click();
  await page.waitForTimeout(150);
  check("redo = saved state again", (await text("dirty-status")) === "All saved", await text("dirty-status"));

  // edit in the detail panel, then someone else changes the file before we save
  await find("Event");
  await tid("action-edit").click();
  await tid("detail-editor").fill("Sự kiện E2E");
  await tid("detail-editor").press("Enter");
  await page.waitForFunction(() => document.querySelector('[data-testid="dirty-status"]')?.textContent?.includes("1"));
  fs.writeFileSync(path.join(sample, "Game.vi.resx"), gameVi().replace("Quái vật", "Quái"));
  await page.keyboard.press("Control+s");
  await tid("dialog-merge").click();
  await page.waitForFunction(() => document.querySelector('[data-testid="dirty-status"]')?.textContent === "All saved");
  check("conflict merged: both changes in the file", gameVi().includes("Sự kiện E2E") && gameVi().includes("<value>Quái</value>"));

  // unsaved edits live in the server: a page reload keeps them
  await find("Event");
  await page.keyboard.press("Enter"); // the editor opens with the whole text selected
  await page.keyboard.type("Nháp");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector('[data-testid="dirty-status"]')?.textContent?.includes("1"));
  check("draft file written", fs.readFileSync(path.join(sample, ".mumain-translator", "draft-vi.json"), "utf-8").includes('"value": "Nháp"'));
  await page.reload();
  await tid("dirty-status").waitFor();
  check("reload keeps unsaved edits", (await text("dirty-status")).startsWith("● 1"), await text("dirty-status"));
  await page.screenshot({ path: path.join(shots, "sample-editing.png") });

  // opening something else asks before discarding
  await tid("open-other").click();
  await tid("path").fill(sample);
  await page.keyboard.press("Enter");
  await tid("open").click();
  await tid("dialog-discard").click();
  await tid("grid").waitFor();
  check("discarded", (await text("dirty-status")) === "All saved", await text("dirty-status"));
  check("the saved file keeps the saved text", gameVi().includes("Sự kiện E2E") && !gameVi().includes("Nháp"));

  // --- team work: status, note, TSV export -> edit in a "sheet" -> import, glossary
  const nextPick = (p: string) => fs.writeFileSync(pickFile, JSON.stringify([p]));
  const saved = () => page.waitForFunction(() => document.querySelector('[data-testid="dirty-status"]')?.textContent === "All saved");
  const project = () => JSON.parse(fs.readFileSync(path.join(sample, ".mumain-translator", "project-vi.json"), "utf-8"));

  await find("Event");
  await page.keyboard.press("Alt+Digit3");
  await tid("detail-status-reviewed").waitFor();
  await page.waitForFunction(() => document.querySelector('[data-testid="detail-status-reviewed"]')?.getAttribute("aria-checked") === "true");
  await tid("detail-note").fill("e2e note");
  await tid("detail-note").press("Enter");
  await page.waitForFunction(() => document.querySelector('[data-testid="dirty-status"]')?.textContent?.includes("1"));
  await tid("save").click();
  await saved();
  check("status + note in project-vi.json", project().records?.Game?.Event?.status === "reviewed" && project().records.Game.Event.note === "e2e note");
  check("the .resx text is not touched by a status", !gameVi().includes("e2e note"));

  const exportPath = path.join(path.dirname(sample), `${path.basename(sample)}-export.tsv`);
  nextPick(exportPath);
  await tid("actions").click();
  await tid("action-export").click();
  await tid("export-all").click();
  await tid("export-go").click();
  await page.waitForTimeout(300);
  const exported = fs.existsSync(exportPath) ? fs.readFileSync(exportPath, "utf-8") : "";
  check("exported TSV", exported.includes("Game\tEvent\tEvent\tSự kiện E2E\treviewed"), exported.slice(0, 200));

  // a colleague fills a missing translation in the sheet
  fs.writeFileSync(exportPath, exported.replace("Game\tConnecting to the server\tConnecting to the server\t\t", "Game\tConnecting to the server\tConnecting to the server\tĐang kết nối\t"));
  nextPick(exportPath);
  await tid("actions").click();
  await tid("action-import").click();
  await tid("import-dialog").waitFor();
  check("import preview lists the change", (await page.locator('[data-testid="import-row"][data-kind="apply"]').count()) === 1);
  await page.screenshot({ path: path.join(shots, "sample-import.png") });
  await tid("import-apply").click();
  await page.waitForTimeout(200);
  check("imported row shown for review", (await text("result-count")) === "1 row" && (await tid("grid").textContent())?.includes("Đang kết nối") === true);
  await tid("save").click();
  await saved();
  check("the unsaved filter is reset after saving", (await text("result-count")) !== "0 rows", await text("result-count"));
  check("import saved, as translated", gameVi().includes("<value>Đang kết nối</value>") && project().records.Game["Connecting to the server"].status === "translated");
  await choose("state-filter", "state-any");

  const glossPath = path.join(path.dirname(sample), `${path.basename(sample)}-glossary.tsv`);
  fs.writeFileSync(glossPath, "﻿Term\tTranslation\tNote\tCategory\nCastle\tLâu Đài\t\tMap\n");
  nextPick(glossPath);
  await tid("actions").click();
  await tid("action-glossary").click();
  await tid("glossary-open").click();
  await tid("glossary-row").first().waitFor();
  check("glossary loaded", (await tid("glossary-row").count()) === 1);
  await tid("glossary-edit").click();
  await tid("glossary-edit-translation").fill("Thành");
  await page.keyboard.press("Escape");
  check("Esc cancels the edit, the dialog stays", (await tid("glossary-row").innerText()).includes("Lâu Đài") && (await tid("glossary-dialog").count()) === 1);
  await tid("glossary-row").dblclick();
  await tid("glossary-edit-translation").fill("Thành");
  await tid("glossary-edit-note").fill("tên map");
  await page.keyboard.press("Enter");
  check("glossary entry edited", (await tid("glossary-row").innerText()).includes("Thành") && (await tid("glossary-edit-row").count()) === 0);
  await tid("glossary-save").click();
  await page.waitForFunction(() => !document.querySelector('[data-testid="glossary-save"]:not([disabled])'));
  check("edited entry saved to the file", fs.readFileSync(glossPath, "utf8").includes("Castle\tThành\ttên map\tMap\t\tconfirmed"), fs.readFileSync(glossPath, "utf8"));
  await page.keyboard.press("Escape");
  await find("Chaos Castle");
  check("no glossary hint on a line kept in English", (await tid("detail-glossary").count()) === 0);
  await choose("severity-filter", "severity-glossary");
  check("glossary filter", (await text("result-count")) === "0 rows", await text("result-count"));
  await page.screenshot({ path: path.join(shots, "sample-team.png") });

  // --- a new language
  await tid("search").fill("");
  await page.keyboard.press("Enter");
  await choose("severity-filter", "severity-any");
  await tid("open-other").click();
  await tid("path").fill(sample);
  await page.keyboard.press("Enter");
  await tid("locale-new").click();
  await tid("locale-new-code").fill("Thai");
  check("bad code refused", await tid("open").isDisabled());
  await tid("locale-new-code").fill("th");
  await tid("open").click();
  await tid("grid").waitFor();
  check("new language opened", (await text("locale")).startsWith("th"), await text("locale"));
  check("nothing written yet", !fs.existsSync(path.join(sample, "Game.th.resx")));
  check("no registration notice outside a MuMain checkout", (await tid("unregistered").count()) === 0);
  await find("Event");
  await page.keyboard.press("Enter");
  await page.keyboard.type("เหตุการณ์");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Control+s");
  await saved();
  check("Game.th.resx created on save", fs.existsSync(path.join(sample, "Game.th.resx")) && fs.readFileSync(path.join(sample, "Game.th.resx"), "utf-8").includes("เหตุการณ์"));

  // --- a checkout with both sources: UI strings and item names side by side
  await tid("open-other").click();
  await tid("path").fill(checkout);
  await page.keyboard.press("Enter");
  await tid("sources").waitFor();
  const sources = await text("sources");
  check("both sources found", sources.includes("src/Localization") && sources.includes("src/bin/Data/Items") && sources.includes("MuMain source"), sources);
  await tid("locale-vi").click();
  await tid("open").click();
  await tid("badge-items").waitFor();
  check("source badges", (await text("badge-resx")) === "UI strings" && (await text("badge-items")) === "Item names · MuMain source", await text("badge-items"));
  await tid("group-all").click();
  await page.screenshot({ path: path.join(shots, "checkout-all.png") });
  await tid("search").fill("");
  await page.keyboard.press("Enter");
  await tid("source-items").click();
  check("item names only", (await text("result-count")) === "488 rows", await text("result-count"));
  await find("7:1");
  check("7:1 finds the item", (await text("result-count")) === "1 row" && (await text("detail-item")) === "7:1", await text("result-count"));
  check('no "keep English" for items', (await tid("action-keep").count()) === 0);
  await page.keyboard.press("Enter");
  await page.keyboard.type("Quyền Trượng Đại Vương Huyền Thoại Cổ Xưa Của Rồng Lửa Đỏ");
  check("49-character counter", (await text("editor-counter")) === "57/49", await text("editor-counter"));
  await page.screenshot({ path: path.join(shots, "checkout-item-too-long.png") });
  await page.locator("[data-testid=inline-editor] input").fill("Mũ Rồng Đỏ");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+s");
  await saved();
  const helms = path.join(checkout, "src/bin/Data/Items/Group07_Helm.json");
  const helm = ItemData.parse([{ name: "Group07_Helm.json", text: fs.readFileSync(helms, "utf-8") }]);
  check("item name written to the JSON file", helm.getName(7 * 512 + 1) === "Mũ Rồng Đỏ");
  check("side data at the checkout root", fs.existsSync(path.join(checkout, ".mumain-translator", "changes.tsv")));
  await tid("group-all").click();
  await find("7:1");
  await page.screenshot({ path: path.join(shots, "checkout-item.png") });
  await tid("search").fill("");
  await page.keyboard.press("Enter");

  // --- a real MuMain checkout (MUMAIN_DIR), when given: screenshots of a full load. Read only.
  const real = process.env.MUMAIN_DIR ?? "";
  if (real && fs.existsSync(real)) {
    await tid("search").fill("");
    await page.keyboard.press("Enter");
    await choose("severity-filter", "severity-any");
    await tid("open-other").click();
    await tid("path").fill(real);
    await page.keyboard.press("Enter");
    // The first translation the checkout has (upstream: de; a team's checkout: its own locale).
    await page.locator('[data-testid^="locale-"]:not([data-testid^="locale-new"])').first().click();
    await tid("open").click();
    await page.waitForFunction(() => /\d,\d{3}/.test(document.querySelector('[data-testid="result-count"]')?.textContent ?? ""));
    check("real folder loads", /\d/.test(await text("result-count")), await text("result-count"));
    await tid("group-all").click();
    await page.screenshot({ path: path.join(shots, "real-all.png") });
    // docs/MuMain-issues_vi.md section 1: a locale the game's language list does not know yet
    const code = (await text("locale")).split(" ")[0]!;
    if ((await tid("unregistered").count()) > 0) {
      await tid("unregistered").click();
      const line = await text("registration-line-optionWindow");
      check("registration line for s_Languages", line.includes(`{ "${code}",`), line);
      await page.screenshot({ path: path.join(shots, "real-registration.png") });
      await page.keyboard.press("Escape");
    }
    // legacy ids come from Text.bmd: #18 is "Gulim" in every checkout (not #470: see
    // docs/MuMain-issues_vi.md section 2, the duplicate key loses it)
    await tid("search").fill("#18");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(100);
    check("real: legacy id search", (await tid("detail").textContent())?.includes("Gulim") === true, await text("detail"));
    await tid("search").fill("");
    await page.keyboard.press("Enter");
    await choose("severity-filter", "severity-problems");
    await page.locator("[data-row]").first().click();
    await page.screenshot({ path: path.join(shots, "real-problems.png") });
  }
} catch (e) {
  check("run", false, String(e));
  await page.screenshot({ path: path.join(shots, "failure.png") }).catch(() => undefined);
} finally {
  await browser.close();
  server.kill();
  fs.rmSync(sample, { recursive: true, force: true });
  fs.rmSync(checkout, { recursive: true, force: true });
  fs.rmSync(pickFile, { force: true });
}

console.log(failures ? `\n${failures} check(s) failed` : "\nall e2e checks passed");
process.exit(failures ? 1 : 0);
