// resxGroup.ts - One group of MuMain/src/Localization (<Group>.en.resx + <Group>.<locale>.resx) as a
// SourceGroup. The translation file is edited in place without reformatting (resx.ts); a locale
// file that does not exist yet is created on the first save, shaped like the en file.

import {
  AppError,
  DEFAULT_LOCALE,
  type ResxDocument,
  checkValue,
  countBySeverity,
  emptyResxLike,
  groupResxFiles,
  hasKeepMark,
  isXmlChar,
  parseResx,
  removeResxEntry,
  resxFileName,
  resxToString,
  resxValues,
  setResxComment,
  setResxValue,
  sha1,
  validateGroup,
  withKeepMark,
} from "../../core";
import type { RowIssue } from "../../shared/api";
import type { Storage } from "../storage";
import type { EntryState, GroupReport, KeyMeta, SourceGroup, WritePlan } from "./types";

const utf8 = (s: string) => new TextEncoder().encode(s);
const emptyDoc: ResxDocument = parseResx("<root>\n</root>\n");

export function stateOf(doc: ResxDocument | null, key: string): EntryState {
  const e = doc ? resxValues(doc).get(key) : undefined;
  return e ? { value: e.value, comment: e.comment } : null;
}

function parse(input: string | Uint8Array, file: string): ResxDocument {
  try {
    return parseResx(input);
  } catch (e) {
    if (e instanceof AppError) throw new AppError(e.code, `${file}: ${e.message}`, { ...e.params, file });
    throw e;
  }
}

async function readText(st: Storage, path: string, file: string): Promise<string | null> {
  if (!(await st.exists(path))) return null;
  const bytes = await st.read(path);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    parse(bytes, file); // parseResx gives the precise error (UTF-16, bad bytes...)
    return new TextDecoder().decode(bytes);
  }
}

export class ResxGroup implements SourceGroup {
  readonly source = "resx" as const;
  readonly canKeep = true;
  readonly itemType = null;
  private order: string[];

  constructor(
    private readonly st: Storage,
    private readonly dir: string, // the Localization folder
    private readonly rel: string, // its path relative to the workspace root ("" = the root itself)
    readonly name: string,
    private readonly files: Record<string, string>, // locale -> file name
    private readonly locale: string,
    private refLocale: string | null,
    private readonly en_: ResxDocument | null,
    private saved_: ResxDocument | null,
    private diskText: string | null,
    private reference_: ResxDocument | null,
  ) {
    this.order = en_ ? [...resxValues(en_).keys()] : [];
    this.current_ = saved_;
  }

  private current_: ResxDocument | null;

  private display = (file: string | undefined) => (file ? (this.rel ? `${this.rel}/${file}` : file) : null);
  get enFile() {
    return this.display(this.files[DEFAULT_LOCALE]);
  }
  get targetFile() {
    return this.display(this.files[this.locale]);
  }
  get referenceFile() {
    return this.refLocale ? this.display(this.files[this.refLocale]) : null;
  }

  keys(): string[] {
    const set = new Set(this.order);
    for (const doc of [this.current_, this.saved_]) if (doc) for (const k of resxValues(doc).keys()) set.add(k);
    return [...set];
  }

  en(key: string): string | null {
    return this.en_ ? (resxValues(this.en_).get(key)?.value ?? null) : null;
  }

  reference(key: string): string | null {
    return this.reference_ ? (resxValues(this.reference_).get(key)?.value ?? null) : null;
  }

  async setReference(locale: string | null): Promise<void> {
    const file = locale ? this.files[locale] : undefined;
    const text = file ? await readText(this.st, this.pathOf(file), file) : null;
    this.reference_ = text === null ? null : parse(text, file!);
    this.refLocale = locale;
  }

  current = (key: string) => stateOf(this.current_, key);
  saved = (key: string) => stateOf(this.saved_, key);

  apply(key: string, state: EntryState): void {
    if (state === null) {
      if (this.current_) this.current_ = removeResxEntry(this.current_, key);
      return;
    }
    if (!this.current_) {
      if (!this.en_) throw new AppError("not-editable", `${this.name} has no English file.`, { group: this.name });
      this.current_ = emptyResxLike(this.en_); // the first key of a file that does not exist yet
    }
    this.current_ = setResxValue(this.current_, key, state.value, { order: this.order, comment: state.comment });
    this.current_ = setResxComment(this.current_, key, state.comment);
  }

  // An existing comment is kept (legacy_id), a new key gets the en one; a text other than English
  // drops the "keep" mark.
  entryFor(key: string, cur: EntryState, text: string): EntryState {
    const en = this.en_ ? resxValues(this.en_).get(key) : undefined;
    const comment = cur ? cur.comment : (en?.comment ?? null);
    return { value: text, comment: text === en?.value ? comment : withKeepMark(comment, false) };
  }

  // keep = stay English on purpose: the value becomes the en text and the comment gets the mark.
  keepEntry(key: string, cur: EntryState, keep: boolean): EntryState {
    const en = this.en_ ? resxValues(this.en_).get(key) : undefined;
    if (!en) throw new AppError("not-editable", `${key} is not in the English file.`, { group: this.name, key });
    if (keep) return { value: en.value, comment: withKeepMark(cur ? cur.comment : en.comment, true) };
    return cur ? { value: cur.value, comment: withKeepMark(cur.comment, false) } : null;
  }

  isKeep = (s: EntryState) => s !== null && hasKeepMark(s.comment);

  validateText(key: string, text: string): void {
    for (const ch of text) {
      if (!isXmlChar(ch.codePointAt(0)!)) {
        throw new AppError("resx-invalid-char", `The text for ${key} holds a character a .resx file cannot store.`, { group: this.name, key });
      }
    }
  }

  check = (en: string, text: string) => checkValue(en, text);

  meta(key: string): KeyMeta {
    const e = this.en_ ? resxValues(this.en_).get(key) : undefined;
    const t = this.current_ ? resxValues(this.current_).get(key) : undefined;
    return { legacyIds: [...((e ?? t)?.legacyIds ?? [])], enLine: e?.line ?? 0, line: t?.line ?? 0 };
  }

  report(): GroupReport {
    const docs: Record<string, ResxDocument> = {};
    if (this.en_) docs[DEFAULT_LOCALE] = this.en_;
    docs[this.locale] = this.current_ ?? emptyDoc;
    const r = validateGroup(this.name, docs);
    const byKey = new Map<string, RowIssue[]>();
    const loose = [];
    for (const issue of r.issues) {
      if (issue.key === undefined) {
        loose.push(issue);
        continue;
      }
      const list = byKey.get(issue.key) ?? [];
      list.push(Object.keys(issue.params).length ? [issue.code, issue.locale, issue.params] : [issue.code, issue.locale]);
      byKey.set(issue.key, list);
    }
    return {
      byKey,
      loose,
      progress: r.progress[this.locale] ?? { total: 0, translated: 0, sameAsEn: 0, kept: 0, extra: 0 },
      counts: countBySeverity(r.issues),
    };
  }

  baseHash = () => sha1(utf8(this.diskText ?? ""));

  private pathOf(file: string) {
    return this.st.join(this.dir, file);
  }

  async diskChanged(): Promise<boolean> {
    const file = this.files[this.locale] ?? resxFileName(this.name, this.locale);
    const p = this.pathOf(file);
    const onDisk = (await this.st.exists(p)) ? new TextDecoder().decode(await this.st.read(p)) : null;
    return onDisk !== this.diskText;
  }

  planWrite(keys: string[]): WritePlan {
    const file = this.files[this.locale] ?? resxFileName(this.name, this.locale);
    const text = resxToString(this.current_ ?? emptyResxLike(this.en_ ?? emptyDoc));
    const check = parse(text, file);
    for (const key of keys) {
      const a = stateOf(check, key);
      const b = this.current(key);
      if (!(a === b || (a && b && a.value === b.value && a.comment === b.comment))) {
        throw new AppError("save-verify-failed", `Internal error: ${file} / ${key} would be written incorrectly - save aborted.`, { file, key });
      }
    }
    return { file: this.display(file)!, path: this.pathOf(file), text, created: this.diskText === null };
  }

  committed(plan: WritePlan): void {
    this.files[this.locale] ??= resxFileName(this.name, this.locale);
    this.saved_ = this.current_;
    this.diskText = plan.text;
  }
}

// The groups of a Localization folder for `locale` (and an optional reference locale). Every file
// is read (and parsed) before returning, so a broken file fails the whole load.
export async function loadResxGroups(st: Storage, dir: string, rel: string, locale: string, ref: string | null): Promise<ResxGroup[]> {
  const out: ResxGroup[] = [];
  for (const g of groupResxFiles(await st.list(dir)).groups) {
    const read = async (l: string | null) => {
      const file = l ? g.files[l] : undefined;
      return file ? readText(st, st.join(dir, file), file) : null;
    };
    const enText = await read(DEFAULT_LOCALE);
    const target = await read(locale);
    const refText = await read(ref);
    out.push(
      new ResxGroup(
        st,
        dir,
        rel,
        g.name,
        { ...g.files },
        locale,
        ref,
        enText === null ? null : parse(enText, g.files[DEFAULT_LOCALE]!),
        target === null ? null : parse(target, g.files[locale]!),
        target,
        refText === null ? null : parse(refText, g.files[ref!]!),
      ),
    );
  }
  return out;
}
