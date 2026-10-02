// package.ts - A translation package: one ZIP to hand a locale's translations to someone else.
// Pure format; built and imported by the Session.
//
//   manifest.json      what it is (locale, who, when, English fingerprints per group)
//   translations.tsv   every key: the translation TSV (with status, note, translator, BaseText), the
//                      way to import it into another checkout with the 3-way merge, whatever its
//                      MuMain version
//   files/<path>       the translated files as saved, laid out like the workspace (unzip over a
//                      checkout of the SAME MuMain version, without the tool)
//   glossary.tsv       the team glossary, when one was loaded
//   README.txt         how to use it (Vietnamese and English)
// A package unzipped and zipped again (inside a folder) still imports: the manifest is looked up
// at any depth.

import { AppError } from "./errors";
import { type ZipEntry, unzip, zip } from "./zip";

export const PACKAGE_FORMAT = "mumain-translator-package";
export const PACKAGE_VERSION = 1;

export interface PackageManifest {
  format: typeof PACKAGE_FORMAT;
  version: typeof PACKAGE_VERSION;
  locale: string;
  createdAt: string; // ISO
  by: string; // translator name of the person who exported it
  tool: string; // MuMain-translator version
  rows: number; // rows in translations.tsv
  translated: number; // of those, with a translation
  files: string[]; // under files/, relative to the workspace root
  glossary: boolean;
  english: Record<string, string>; // group -> fingerprint of its English texts
}

export interface PackageParts {
  manifest: Omit<PackageManifest, "format" | "version" | "files" | "glossary">;
  translations: string; // TSV text
  files: { path: string; bytes: Uint8Array }[];
  glossary: string | null; // TSV text
}

export interface ReadPackage {
  manifest: PackageManifest;
  translations: string;
  glossary: string | null;
  files: string[];
}

const enc = new TextEncoder();
const dec = new TextDecoder();

const README = (m: PackageParts["manifest"], files: string[], glossary: boolean) => `MuMain-translator - Gói bản dịch / Translation package
Ngôn ngữ / Locale: ${m.locale}    Người xuất / Exported by: ${m.by || "?"}    Ngày / Date: ${m.createdAt.slice(0, 10)}
Số dòng / Rows: ${m.rows} (đã dịch / translated: ${m.translated})

[Tiếng Việt]
Cách 1 - Dùng MuMain-translator (khuyên dùng; chạy được cả khi khác phiên bản MuMain):
  Mở thư mục MuMain của bạn trong MuMain-translator (bản web hoặc desktop), chọn ngôn ngữ ${m.locale},
  rồi Thao tác -> Nhập bản dịch (TSV / gói .zip) -> chọn file .zip này -> xem trước -> Áp dụng -> Lưu.
  Bản dịch được gộp theo từng dòng: thay đổi của bạn không bị ghi đè, chỗ hai bên cùng sửa được báo xung đột.
Cách 2 - Không dùng tool (chỉ khi cùng phiên bản MuMain với người gửi):
  Chép nội dung thư mục files/ đè vào thư mục gốc MuMain (${files.length} file).
Sau đó: chuỗi giao diện (src/Localization) cần build lại MuMain; tên vật phẩm (Data/Items) chỉ cần mở lại game.${glossary ? "\nBảng thuật ngữ của nhóm: glossary.tsv (khi nhập gói, tool hỏi có dùng không)." : ""}

[English]
Option 1 - With MuMain-translator (recommended; works across MuMain versions):
  Open your MuMain folder in MuMain-translator (web or desktop) for locale ${m.locale}, then
  Actions -> Import translations (TSV / .zip package) -> pick this .zip -> preview -> Apply -> Save.
  Translations are merged key by key: your own changes are kept, keys changed on both sides are conflicts.
Option 2 - Without the tool (only with the same MuMain version as the sender):
  Copy the contents of files/ over your MuMain root folder (${files.length} files).
Afterwards: UI strings (src/Localization) need a MuMain rebuild; item names (Data/Items) only a game restart.${glossary ? "\nThe team glossary: glossary.tsv (the import offers to use it)." : ""}
`;

export function buildPackage(parts: PackageParts, date = new Date()): Uint8Array {
  const files = parts.files.map((f) => f.path.replace(/\\/g, "/"));
  const manifest: PackageManifest = { format: PACKAGE_FORMAT, version: PACKAGE_VERSION, ...parts.manifest, files, glossary: parts.glossary !== null };
  const entries: ZipEntry[] = [
    { name: "manifest.json", bytes: enc.encode(`${JSON.stringify(manifest, null, 2)}\n`) },
    { name: "README.txt", bytes: enc.encode(README(parts.manifest, files, parts.glossary !== null).replace(/\n/g, "\r\n")) },
    { name: "translations.tsv", bytes: enc.encode(parts.translations) },
    ...(parts.glossary !== null ? [{ name: "glossary.tsv", bytes: enc.encode(parts.glossary) }] : []),
    ...parts.files.map((f, i) => ({ name: `files/${files[i]}`, bytes: f.bytes })),
  ];
  return zip(entries, date);
}

const invalid = (detail: string) => new AppError("package-invalid", `Not a translation package: ${detail}.`, { detail });

export function readPackage(bytes: Uint8Array): ReadPackage {
  const entries = unzip(bytes);
  const manifestEntry = entries
    .filter((e) => e.name === "manifest.json" || e.name.endsWith("/manifest.json"))
    .sort((a, b) => a.name.length - b.name.length)[0];
  if (!manifestEntry) throw invalid("no manifest.json");
  const prefix = manifestEntry.name.slice(0, -"manifest.json".length);
  let manifest: PackageManifest;
  try {
    manifest = JSON.parse(dec.decode(manifestEntry.bytes)) as PackageManifest;
  } catch (e) {
    throw invalid(`manifest.json: ${(e as Error).message}`);
  }
  if (manifest?.format !== PACKAGE_FORMAT) throw invalid("manifest.json is not a MuMain-translator package");
  if (manifest.version !== PACKAGE_VERSION) throw invalid(`package version ${String(manifest.version)}`);
  if (typeof manifest.locale !== "string" || !manifest.locale) throw invalid("no locale");
  const get = (name: string) => entries.find((e) => e.name === prefix + name);
  const translations = get("translations.tsv");
  if (!translations) throw invalid("no translations.tsv");
  const glossary = get("glossary.tsv");
  return {
    manifest: { ...manifest, english: manifest.english ?? {}, files: Array.isArray(manifest.files) ? manifest.files : [] },
    translations: dec.decode(translations.bytes),
    glossary: glossary ? dec.decode(glossary.bytes) : null,
    files: entries.filter((e) => e.name.startsWith(`${prefix}files/`)).map((e) => e.name.slice(prefix.length + 6)),
  };
}
