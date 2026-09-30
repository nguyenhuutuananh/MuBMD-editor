// filePicker.ts - Native OS open/save dialogs (possible because the server runs on the user's own
// machine): AppleScript on macOS, Windows Forms through PowerShell on Windows, zenity or kdialog on
// Linux. Returns null when the user cancels.

import { spawn } from "node:child_process";
import * as path from "node:path";
import { AppError } from "../core";
import { FOLDER_KINDS, type Lang, type PickKind, type SaveKind } from "../shared/api";

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
    game: "Choose the game folder (the folder with Main.exe or Main.app)",
    compare: "Choose another game folder to compare with",
    tsv: "Choose a translation file (TSV)",
    reference: "Choose a reference file (TSV or CSV)",
    glossary: "Choose a glossary file (TSV or CSV)",
    saveTsv: "Export translations as",
    saveGlossary: "Save the glossary as",
    all: "All files",
  },
  vi: {
    game: "Chọn thư mục game (thư mục có Main.exe hoặc Main.app)",
    compare: "Chọn thư mục game khác để so sánh",
    tsv: "Chọn file bản dịch (TSV)",
    reference: "Chọn file tham chiếu (TSV hoặc CSV)",
    glossary: "Chọn file thuật ngữ (TSV hoặc CSV)",
    saveTsv: "Xuất bản dịch thành",
    saveGlossary: "Lưu bảng thuật ngữ thành",
    all: "Tất cả",
  },
} satisfies Record<Lang, Record<string, string>>;

const isFolder = (kind: PickKind) => FOLDER_KINDS.includes(kind);
const promptOf = (lang: Lang, kind: PickKind) => TEXT[lang][kind];
const savePrompt = (lang: Lang, kind: SaveKind) => (kind === "tsv" ? TEXT[lang].saveTsv : TEXT[lang].saveGlossary);

// macOS uniform type identifiers / file extensions, and the Windows / zenity filters (all text files).
const MAC_TYPES = '{"tsv", "csv", "txt", "public.plain-text", "public.tab-separated-values-text", "public.comma-separated-values-text"}';
const WIN_FILTER = (all: string) => `TSV / CSV (*.tsv;*.csv;*.txt)|*.tsv;*.csv;*.txt|${all} (*.*)|*.*`;
const LINUX_PATTERNS = "*.tsv *.csv *.txt";

const appleString = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
const psString = (s: string) => `'${s.replace(/'/g, "''")}'`;
const psScript = (lines: string[]) => [
  "powershell.exe",
  "-NoProfile",
  "-STA",
  "-Command",
  ["[Console]::OutputEncoding = [Text.Encoding]::UTF8;", "Add-Type -AssemblyName System.Windows.Forms;", ...lines].filter(Boolean).join(" "),
];

// Linux has no single dialog tool: the first of these that is installed is used.
type Candidates = string[][];

function openCommands(lang: Lang, kind: PickKind, dir?: string): Candidates {
  const prompt = promptOf(lang, kind);
  const folder = isFolder(kind);
  switch (process.platform) {
    case "darwin": {
      const where = dir ? ` default location (POSIX file ${appleString(dir)})` : "";
      const what = folder ? `choose folder with prompt ${appleString(prompt)}` : `choose file with prompt ${appleString(prompt)} of type ${MAC_TYPES}`;
      return [["osascript", "-e", `POSIX path of (${what}${where})`]];
    }
    case "win32":
      return [
        psScript(
          folder
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
                `$d.Filter = ${psString(WIN_FILTER(TEXT[lang].all))};`,
                dir ? `$d.InitialDirectory = ${psString(dir)};` : "",
                "if ($d.ShowDialog() -eq 'OK') { $d.FileName }",
              ],
        ),
      ];
    case "linux": {
      const start = dir ? `${dir}/` : undefined;
      return [
        ["zenity", "--file-selection", `--title=${prompt}`, ...(folder ? ["--directory"] : [`--file-filter=TSV / CSV | ${LINUX_PATTERNS}`]), ...(start ? [`--filename=${start}`] : [])],
        folder
          ? ["kdialog", "--title", prompt, "--getexistingdirectory", dir ?? "."]
          : ["kdialog", "--title", prompt, "--getopenfilename", dir ?? ".", LINUX_PATTERNS],
      ];
    }
    default:
      throw new FilePickerUnavailableError("picker-unsupported");
  }
}

function saveCommands(defaultPath: string, lang: Lang, kind: SaveKind): Candidates {
  const prompt = savePrompt(lang, kind);
  const dir = path.dirname(defaultPath);
  const name = path.basename(defaultPath);
  switch (process.platform) {
    case "darwin":
      return [
        [
          "osascript",
          "-e",
          `POSIX path of (choose file name with prompt ${appleString(prompt)} default name ${appleString(name)} default location (POSIX file ${appleString(dir)}))`,
        ],
      ];
    case "win32":
      return [
        psScript([
          "$d = New-Object System.Windows.Forms.SaveFileDialog;",
          `$d.Title = ${psString(prompt)};`,
          `$d.Filter = ${psString(WIN_FILTER(TEXT[lang].all))};`,
          `$d.InitialDirectory = ${psString(dir)};`,
          `$d.FileName = ${psString(name)};`,
          "if ($d.ShowDialog() -eq 'OK') { $d.FileName }",
        ]),
      ];
    case "linux":
      return [
        ["zenity", "--file-selection", "--save", "--confirm-overwrite", `--title=${prompt}`, `--filename=${defaultPath}`],
        ["kdialog", "--title", prompt, "--getsavefilename", defaultPath, LINUX_PATTERNS],
      ];
    default:
      throw new FilePickerUnavailableError("picker-unsupported");
  }
}

class NotInstalled extends Error {}

function run(cmd: string[]): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    const [bin, ...args] = cmd;
    const proc = spawn(bin!, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let out = "";
    let err = "";
    proc.stdout.setEncoding("utf8").on("data", (d: string) => (out += d));
    proc.stderr.setEncoding("utf8").on("data", (d: string) => (err += d));
    proc.on("error", (e: NodeJS.ErrnoException) =>
      reject(e.code === "ENOENT" ? new NotInstalled(bin) : new FilePickerUnavailableError("picker-failed", e.message)),
    );
    proc.on("close", (code) => resolve({ code: code ?? -1, out, err }));
  });
}

async function runPicker(candidates: Candidates): Promise<string | null> {
  for (const cmd of candidates) {
    let res: { code: number; out: string; err: string };
    try {
      res = await run(cmd);
    } catch (e) {
      if (e instanceof NotInstalled) continue;
      throw e;
    }
    const picked = res.out.trim();
    if (res.code === 0) return picked || null;
    // osascript exits with code 1 + "User canceled" (-128) when the user clicks Cancel; zenity and
    // kdialog exit with 1.
    if (process.platform === "darwin" && res.err.includes("-128")) return null;
    if (process.platform === "linux" && res.code === 1) return null;
    throw new FilePickerUnavailableError("picker-failed", res.err.trim() || `exit code ${res.code}`);
  }
  throw new FilePickerUnavailableError("picker-unsupported");
}

export const pickFile = (lang: Lang = "en", kind: PickKind = "game", dir?: string): Promise<string | null> =>
  runPicker(openCommands(lang, kind, dir));

// "Save as" dialog (the OS itself asks before overwriting an existing file).
export const pickSaveFile = (defaultPath: string, lang: Lang = "en", kind: SaveKind = "tsv"): Promise<string | null> =>
  runPicker(saveCommands(defaultPath, lang, kind));
