// filePicker.ts - Native OS open/save dialogs (possible because the server runs on the
// user's own machine). Returns null when the user cancels.

import { spawn } from "node:child_process";
import * as path from "node:path";
import { AppError } from "../core";
import type { Lang } from "../shared/api";

export class FilePickerUnavailableError extends AppError {
  constructor(code: "picker-unsupported" | "picker-failed", detail = "") {
    super(code, code === "picker-unsupported" ? "No native file dialog on this OS - type a path instead." : `File dialog failed: ${detail}`, {
      detail,
    });
  }
}

// Dialog captions follow the UI language.
const TEXT = {
  en: { open: "Choose Item.bmd", save: "Save Item.bmd as", all: "All files" },
  vi: { open: "Chọn file Item.bmd", save: "Lưu Item.bmd thành", all: "Tất cả" },
} satisfies Record<Lang, Record<string, string>>;

function pickerCommand(lang: Lang): string[] {
  const t = TEXT[lang];
  switch (process.platform) {
    case "darwin":
      return [
        "osascript",
        "-e",
        `POSIX path of (choose file with prompt ${appleString(t.open)} of type {"bmd", "public.data"})`,
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
          `$d.Title = ${psString(t.open)};`,
          `$d.Filter = ${psString(`BMD (*.bmd)|*.bmd|${t.all} (*.*)|*.*`)};`,
          "if ($d.ShowDialog() -eq 'OK') { $d.FileName }",
        ].join(" "),
      ];
    default:
      throw new FilePickerUnavailableError("picker-unsupported");
  }
}

function savePickerCommand(defaultPath: string, lang: Lang): string[] {
  const t = TEXT[lang];
  const dir = path.dirname(defaultPath);
  const name = path.basename(defaultPath);
  switch (process.platform) {
    case "darwin":
      return [
        "osascript",
        "-e",
        `POSIX path of (choose file name with prompt ${appleString(t.save)} default name ${appleString(name)} default location (POSIX file ${appleString(dir)}))`,
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
          `$d.Title = ${psString(t.save)};`,
          `$d.Filter = ${psString(`BMD (*.bmd)|*.bmd|${t.all} (*.*)|*.*`)};`,
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

export const pickFile = (lang: Lang = "en"): Promise<string | null> => runPicker(pickerCommand(lang));

// "Save as" dialog (the OS itself asks before overwriting an existing file).
export const pickSaveFile = (defaultPath: string, lang: Lang = "en"): Promise<string | null> =>
  runPicker(savePickerCommand(defaultPath, lang));
