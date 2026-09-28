// filePicker.ts - Mở hộp thoại chọn file gốc của hệ điều hành (server chạy
// trên chính máy người dùng nên làm được). Trả về null nếu người dùng bấm Huỷ.

import * as path from "node:path";

export class FilePickerUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FilePickerUnavailableError";
  }
}

function pickerCommand(): string[] {
  switch (process.platform) {
    case "darwin":
      return [
        "osascript",
        "-e",
        'POSIX path of (choose file with prompt "Chọn file Item.bmd" of type {"bmd", "public.data"})',
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
          "$d.Title = 'Chọn file Item.bmd';",
          "$d.Filter = 'BMD (*.bmd)|*.bmd|Tất cả (*.*)|*.*';",
          "if ($d.ShowDialog() -eq 'OK') { $d.FileName }",
        ].join(" "),
      ];
    default:
      throw new FilePickerUnavailableError("Hệ điều hành này chưa hỗ trợ hộp thoại chọn file - hãy nhập đường dẫn.");
  }
}

function savePickerCommand(defaultPath: string): string[] {
  const dir = path.dirname(defaultPath);
  const name = path.basename(defaultPath);
  switch (process.platform) {
    case "darwin":
      return [
        "osascript",
        "-e",
        `POSIX path of (choose file name with prompt "Lưu Item.bmd thành" default name ${appleString(name)} default location (POSIX file ${appleString(dir)}))`,
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
          "$d.Title = 'Lưu Item.bmd thành';",
          "$d.Filter = 'BMD (*.bmd)|*.bmd|Tất cả (*.*)|*.*';",
          `$d.InitialDirectory = ${psString(dir)};`,
          `$d.FileName = ${psString(name)};`,
          "if ($d.ShowDialog() -eq 'OK') { $d.FileName }",
        ].join(" "),
      ];
    default:
      throw new FilePickerUnavailableError("Hệ điều hành này chưa hỗ trợ hộp thoại lưu file.");
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
  throw new FilePickerUnavailableError(`Không mở được hộp thoại chọn file: ${err.trim() || `mã thoát ${code}`}`);
}

export const pickFile = (): Promise<string | null> => runPicker(pickerCommand());

// Hộp thoại "Lưu thành" (hệ điều hành tự hỏi nếu file đã tồn tại).
export const pickSaveFile = (defaultPath: string): Promise<string | null> => runPicker(savePickerCommand(defaultPath));
