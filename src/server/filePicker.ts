// filePicker.ts - Mở hộp thoại chọn file gốc của hệ điều hành (server chạy
// trên chính máy người dùng nên làm được). Trả về null nếu người dùng bấm Huỷ.

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

// Chữ trên hộp thoại của hệ điều hành theo ngôn ngữ giao diện.
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

async function runPicker(cmd: string[]): Promise<string | null> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const picked = out.trim();
  if (code === 0) return picked || null;
  // osascript trả mã 1 + "User canceled" (-128) khi bấm Huỷ.
  if (process.platform === "darwin" && err.includes("-128")) return null;
  throw new FilePickerUnavailableError("picker-failed", err.trim() || `exit code ${code}`);
}

export const pickFile = (lang: Lang = "en"): Promise<string | null> => runPicker(pickerCommand(lang));

// Hộp thoại "Lưu thành" (hệ điều hành tự hỏi nếu file đã tồn tại).
export const pickSaveFile = (defaultPath: string, lang: Lang = "en"): Promise<string | null> =>
  runPicker(savePickerCommand(defaultPath, lang));
