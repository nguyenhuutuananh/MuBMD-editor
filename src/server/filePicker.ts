// filePicker.ts - Native OS open/save dialogs (possible because the server runs on the
// user's own machine). Returns null when the user cancels.

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

// Dialog captions follow the UI language.
const TEXT = {
  en: {
    open: "Choose Item.bmd",
    save: "Save Item.bmd as",
    openTsv: "Choose a translation file (TSV)",
    saveTsv: "Export translations as",
    openRef: "Choose a reference file (Item.bmd, TSV or CSV)",
    openGlossary: "Choose a glossary file (TSV or CSV)",
    saveGlossary: "Save the glossary as",
    openCompare: "Choose another Item.bmd to compare with",
    all: "All files",
  },
  vi: {
    open: "Chọn file Item.bmd",
    save: "Lưu Item.bmd thành",
    openTsv: "Chọn file bản dịch (TSV)",
    saveTsv: "Xuất bản dịch thành",
    openRef: "Chọn file tham chiếu (Item.bmd, TSV hoặc CSV)",
    openGlossary: "Chọn file thuật ngữ (TSV hoặc CSV)",
    saveGlossary: "Lưu bảng thuật ngữ thành",
    openCompare: "Chọn Item.bmd khác để so sánh",
    all: "Tất cả",
  },
} satisfies Record<Lang, Record<string, string>>;

// macOS uniform type identifiers / file extensions, and the Windows filter per file kind.
const TEXT_TYPES = '"tsv", "csv", "txt", "public.plain-text", "public.tab-separated-values-text", "public.comma-separated-values-text"';
const MAC_TYPES: Record<PickKind, string> = {
  bmd: '{"bmd", "public.data"}',
  "bmd-file": '{"bmd", "public.data"}',
  compare: '{"bmd", "public.data"}',
  tsv: `{${TEXT_TYPES}}`,
  glossary: `{${TEXT_TYPES}}`,
  reference: `{"bmd", "public.data", ${TEXT_TYPES}}`,
};
const WIN_FILTER = (kind: PickKind, all: string) =>
  ({
    bmd: "BMD (*.bmd)|*.bmd",
    "bmd-file": "BMD (*.bmd)|*.bmd",
    compare: "BMD (*.bmd)|*.bmd",
    tsv: "TSV / CSV (*.tsv;*.csv;*.txt)|*.tsv;*.csv;*.txt",
    glossary: "TSV / CSV (*.tsv;*.csv;*.txt)|*.tsv;*.csv;*.txt",
    reference: "BMD / TSV / CSV (*.bmd;*.tsv;*.csv;*.txt)|*.bmd;*.tsv;*.csv;*.txt",
  })[kind] + `|${all} (*.*)|*.*`;

function pickerCommand(lang: Lang, kind: PickKind, dir?: string): string[] {
  const t = TEXT[lang];
  const prompt = { bmd: t.open, "bmd-file": t.open, tsv: t.openTsv, reference: t.openRef, glossary: t.openGlossary, compare: t.openCompare }[kind];
  switch (process.platform) {
    case "darwin":
      return [
        "osascript",
        "-e",
        `POSIX path of (choose file with prompt ${appleString(prompt)} of type ${MAC_TYPES[kind]}${
          dir ? ` default location (POSIX file ${appleString(dir)})` : ""
        })`,
      ];
    case "win32":
      return [
        "powershell.exe",
        "-NoProfile",
        "-STA",
        "-Command",
        [
          "[Console]::OutputEncoding = [Text.Encoding]::UTF8;",
          "Add-Type -AssemblyName System.Windows.Forms;",
          "$d = New-Object System.Windows.Forms.OpenFileDialog;",
          `$d.Title = ${psString(prompt)};`,
          `$d.Filter = ${psString(WIN_FILTER(kind, t.all))};`,
          dir ? `$d.InitialDirectory = ${psString(dir)};` : "",
          "if ($d.ShowDialog() -eq 'OK') { $d.FileName }",
        ].join(" "),
      ];
    default:
      throw new FilePickerUnavailableError("picker-unsupported");
  }
}

function savePickerCommand(defaultPath: string, lang: Lang, kind: "bmd" | "tsv" | "glossary"): string[] {
  const t = TEXT[lang];
  const prompt = { bmd: t.save, tsv: t.saveTsv, glossary: t.saveGlossary }[kind];
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
      return [
        "powershell.exe",
        "-NoProfile",
        "-STA",
        "-Command",
        [
          "[Console]::OutputEncoding = [Text.Encoding]::UTF8;",
          "Add-Type -AssemblyName System.Windows.Forms;",
          "$d = New-Object System.Windows.Forms.SaveFileDialog;",
          `$d.Title = ${psString(prompt)};`,
          `$d.Filter = ${psString(WIN_FILTER(kind === "glossary" ? "tsv" : kind, t.all))};`,
          `$d.InitialDirectory = ${psString(dir)};`,
          `$d.FileName = ${psString(name)};`,
          "if ($d.ShowDialog() -eq 'OK') { $d.FileName }",
        ].join(" "),
      ];
    default:
      throw new FilePickerUnavailableError("picker-unsupported");
  }
}

const appleString = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
const psString = (s: string) => `'${s.replace(/'/g, "''")}'`;

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
  const picked = out.trim();
  if (code === 0) return picked || null;
  // osascript exits with code 1 + "User canceled" (-128) when the user clicks Cancel.
  if (process.platform === "darwin" && err.includes("-128")) return null;
  throw new FilePickerUnavailableError("picker-failed", err.trim() || `exit code ${code}`);
}

export const pickFile = (lang: Lang = "en", kind: PickKind = "bmd", dir?: string): Promise<string | null> =>
  runPicker(pickerCommand(lang, kind, dir));

// "Save as" dialog (the OS itself asks before overwriting an existing file).
export const pickSaveFile = (defaultPath: string, lang: Lang = "en", kind: "bmd" | "tsv" | "glossary" = "bmd"): Promise<string | null> =>
  runPicker(savePickerCommand(defaultPath, lang, kind));
