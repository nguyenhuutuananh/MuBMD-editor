// filePicker.ts - Native OS open / save dialogs (possible because the server runs on the user's
// own machine). Returns null when the user cancels.

import { spawn } from "node:child_process";
import * as path from "node:path";
import { AppError } from "../core";
import type { Lang, PickKind } from "../shared/api";

export class FilePickerUnavailableError extends AppError {
  constructor(code: "picker-unsupported" | "picker-failed", detail = "") {
    super(code, code === "picker-unsupported" ? "No native file dialog on this OS - type a path instead." : `File dialog failed: ${detail}`, {
      detail,
    });
  }
}

export type SaveKind = "tsv" | "glossary" | "zip";

// Dialog captions follow the UI language.
const TEXT = {
  en: {
    folder: "Choose the Localization folder (MuMain/src/Localization)",
    tsv: "Choose a translation file (TSV, CSV or a .zip package)",
    glossary: "Choose a glossary file (TSV or CSV, the same as MuBMD-editor's)",
    saveTsv: "Export translations as",
    saveGlossary: "Save the glossary as",
    saveZip: "Save the translation package as",
    all: "All files",
  },
  vi: {
    folder: "Chọn thư mục Localization (MuMain/src/Localization)",
    tsv: "Chọn file bản dịch (TSV, CSV hoặc gói .zip)",
    glossary: "Chọn file thuật ngữ (TSV hoặc CSV, dùng chung với MuBMD-editor)",
    saveTsv: "Xuất bản dịch thành",
    saveGlossary: "Lưu bảng thuật ngữ thành",
    saveZip: "Lưu gói bản dịch thành",
    all: "Tất cả",
  },
} satisfies Record<Lang, Record<string, string>>;

const MAC_TEXT_TYPES = '{"tsv", "csv", "txt", "public.plain-text", "public.tab-separated-values-text", "public.comma-separated-values-text"}';
// Translation files can also be packages (.zip).
const MAC_IMPORT_TYPES = '{"tsv", "csv", "txt", "zip", "public.plain-text", "public.tab-separated-values-text", "public.comma-separated-values-text", "public.zip-archive"}';
const WIN_TEXT_FILTER = (all: string) => `TSV / CSV (*.tsv;*.csv;*.txt)|*.tsv;*.csv;*.txt|${all} (*.*)|*.*`;
const WIN_IMPORT_FILTER = (all: string) => `TSV / CSV / ZIP (*.tsv;*.csv;*.txt;*.zip)|*.tsv;*.csv;*.txt;*.zip|${all} (*.*)|*.*`;
const WIN_ZIP_FILTER = (all: string) => `ZIP (*.zip)|*.zip|${all} (*.*)|*.*`;

const appleString = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
const psString = (s: string) => `'${s.replace(/'/g, "''")}'`;
const powershell = (lines: string[]) => [
  "powershell.exe",
  "-NoProfile",
  "-STA",
  "-Command",
  ["[Console]::OutputEncoding = [Text.Encoding]::UTF8;", "Add-Type -AssemblyName System.Windows.Forms;", ...lines].join(" "),
];

function pickerCommand(lang: Lang, kind: PickKind, dir?: string): string[] {
  const t = TEXT[lang];
  const prompt = t[kind];
  const at = (s: string) => (dir ? ` default location (POSIX file ${appleString(dir)})` : s);
  switch (process.platform) {
    case "darwin":
      return [
        "osascript",
        "-e",
        kind === "folder"
          ? `POSIX path of (choose folder with prompt ${appleString(prompt)}${at("")})`
          : `POSIX path of (choose file with prompt ${appleString(prompt)} of type ${kind === "tsv" ? MAC_IMPORT_TYPES : MAC_TEXT_TYPES}${at("")})`,
      ];
    case "win32":
      return powershell(
        kind === "folder"
          ? [
              "$d = New-Object System.Windows.Forms.FolderBrowserDialog;",
              `$d.Description = ${psString(prompt)};`,
              "$d.ShowNewFolderButton = $false;",
              dir ? `$d.SelectedPath = ${psString(dir)};` : "",
              "if ($d.ShowDialog() -eq 'OK') { $d.SelectedPath }",
            ]
          : [
              "$d = New-Object System.Windows.Forms.OpenFileDialog;",
              `$d.Title = ${psString(prompt)};`,
              `$d.Filter = ${psString((kind === "tsv" ? WIN_IMPORT_FILTER : WIN_TEXT_FILTER)(t.all))};`,
              dir ? `$d.InitialDirectory = ${psString(dir)};` : "",
              "if ($d.ShowDialog() -eq 'OK') { $d.FileName }",
            ],
      );
    default:
      throw new FilePickerUnavailableError("picker-unsupported");
  }
}

function savePickerCommand(defaultPath: string, lang: Lang, kind: SaveKind): string[] {
  const t = TEXT[lang];
  const prompt = kind === "tsv" ? t.saveTsv : kind === "zip" ? t.saveZip : t.saveGlossary;
  const dir = path.dirname(defaultPath);
  const name = path.basename(defaultPath);
  switch (process.platform) {
    case "darwin":
      return [
        "osascript",
        "-e",
        `POSIX path of (choose file name with prompt ${appleString(prompt)} default name ${appleString(name)} default location (POSIX file ${appleString(dir)}))`,
      ];
    case "win32":
      return powershell([
        "$d = New-Object System.Windows.Forms.SaveFileDialog;",
        `$d.Title = ${psString(prompt)};`,
        `$d.Filter = ${psString((kind === "zip" ? WIN_ZIP_FILTER : WIN_TEXT_FILTER)(t.all))};`,
        `$d.InitialDirectory = ${psString(dir)};`,
        `$d.FileName = ${psString(name)};`,
        "if ($d.ShowDialog() -eq 'OK') { $d.FileName }",
      ]);
    default:
      throw new FilePickerUnavailableError("picker-unsupported");
  }
}

function run(cmd: string[]): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    const [bin, ...args] = cmd;
    const proc = spawn(bin!, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let out = "";
    let err = "";
    proc.stdout.setEncoding("utf8").on("data", (d: string) => (out += d));
    proc.stderr.setEncoding("utf8").on("data", (d: string) => (err += d));
    proc.on("error", (e) => reject(new FilePickerUnavailableError("picker-failed", e.message)));
    proc.on("close", (code) => resolve({ code: code ?? -1, out, err }));
  });
}

async function runPicker(cmd: string[]): Promise<string | null> {
  const { code, out, err } = await run(cmd);
  // macOS returns folders with a trailing slash.
  const picked = out.trim().replace(/(.)[\\/]$/, "$1");
  if (code === 0) return picked || null;
  // osascript exits with code 1 + "User canceled" (-128) when the user clicks Cancel.
  if (process.platform === "darwin" && err.includes("-128")) return null;
  throw new FilePickerUnavailableError("picker-failed", err.trim() || `exit code ${code}`);
}

export const pickFile = (lang: Lang = "en", kind: PickKind = "folder", dir?: string): Promise<string | null> =>
  runPicker(pickerCommand(lang, kind, dir));

// "Save as" dialog (the OS itself asks before overwriting an existing file).
export const pickSaveFile = (defaultPath: string, lang: Lang = "en", kind: SaveKind = "tsv"): Promise<string | null> =>
  runPicker(savePickerCommand(defaultPath, lang, kind));
