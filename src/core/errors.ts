// errors.ts - Errors carrying a code + params. The server returns code/params as-is and the UI
// translates them into the user's language (the English message is only for logs / fallback).

export type ErrorCode =
  // format / data
  | "resx-encoding" // not UTF-8 (bad bytes, UTF-16 BOM, or a declaration naming another encoding)
  | "resx-xml" // not well-formed XML (params: line, column, detail)
  | "resx-root" // the document element is not <root>
  | "resx-invalid-char" // a value/key holds a character XML 1.0 cannot represent
  | "resx-not-editable" // the entry's <value> is not plain text (child elements, typed entry)
  | "resx-file-name" // a file name is not <Group>.<locale>.resx
  | "locale-code" // not a usable locale code (e.g. "vi", "zh-TW")
  | "tsv-header" // a translation TSV without Group, Key and Translation columns (params: columns)
  | "import-changed" // the imported file changed since its preview
  | "item-json" // an item file (Data/Items/*.json) MuMain could not load either (params: file, detail)
  | "item-name-invalid" // an item name the game cannot take ("||", control characters) (params: code)
  | "proposal-invalid" // not a proposal file (params: detail)
  // session
  | "no-folder" // nothing is open yet
  | "nothing-to-translate" // the folder has neither Localization .resx files nor item data (params: path)
  | "items-not-found" // no Data/Items in the folder (params: folder)
  | "no-resx" // the folder has no <Group>.<locale>.resx file
  | "no-default" // no <Group>.en.resx at all: nothing to translate from
  | "locale-not-found" // the folder has no file for that locale
  | "dirty" // unsaved changes would be lost (params: count)
  | "conflict" // files changed on disk since they were read (params: files)
  | "save-verify-failed" // the file written would not read back as intended
  | "not-editable" // the row cannot be edited (key not in en, group without en)
  // file system
  | "file-not-found"
  | "not-a-folder"
  | "file-locked"
  | "permission-denied"
  | "is-directory"
  | "disk-full"
  // native OS dialogs
  | "picker-unsupported"
  | "picker-failed"
  // HTTP
  | "missing-path"
  | "bad-json"
  | "unsupported-media"
  | "not-local"
  | "unknown-api"
  | "internal";

export type ErrorParams = Record<string, string | number>;

export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly params: ErrorParams = {},
  ) {
    super(message);
    this.name = new.target.name;
  }
}
