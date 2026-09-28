// errors.ts - Errors carrying a code + params. The server returns code/params as-is and the UI
// translates them into the user's language (the English message is only for logs / fallback).

export type ErrorCode =
  // format / data
  | "bmd-size"
  | "invalid-slot"
  | "invalid-name"
  | "name-bytes-length"
  | "tsv-header"
  // session
  | "no-file"
  | "dirty"
  | "conflict"
  | "save-verify-failed"
  | "import-changed"
  // file system
  | "file-not-found"
  | "file-locked"
  | "permission-denied"
  | "is-directory"
  | "not-a-file"
  | "disk-full"
  // native OS dialogs
  | "picker-unsupported"
  | "picker-failed"
  // HTTP
  | "missing-path"
  | "missing-name"
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
