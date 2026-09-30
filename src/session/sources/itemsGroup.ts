// itemsGroup.ts - One item file of MuMain's Data/Items (GroupNN_<Name>.json) as a SourceGroup:
// keys are the item numbers ("0", "1"...), English is name.en and the translation is name.<locale>
// of the same file. Only the "name" value of renamed items is rewritten (itemData.ts).

import {
  AppError,
  BLOCKING_ITEM_ISSUES,
  ItemData,
  MAX_ITEM_INDEX,
  SEVERITY,
  type Severity,
  checkItemName,
  isItemFileName,
  itemGroupName,
  itemNameIssues,
  sha1,
} from "../../core";
import type { RowIssue } from "../../shared/api";
import type { Storage } from "../storage";
import type { EntryState, GroupReport, KeyMeta, SourceGroup, WritePlan } from "./types";

const utf8 = (s: string) => new TextEncoder().encode(s);

export class ItemsGroup implements SourceGroup {
  readonly source = "items" as const;
  readonly canKeep = false;
  private readonly slotBase: number;
  readonly itemType: number;

  constructor(
    private readonly st: Storage,
    private readonly path: string,
    private readonly file: string, // display name, relative to the workspace root
    readonly name: string,
    private readonly locale: string,
    private refLocale: string | null,
    private data: ItemData,
    private diskText: string,
  ) {
    this.itemType = data.fileGroup(data.fileNames[0]!) ?? 0;
    this.slotBase = this.itemType * MAX_ITEM_INDEX;
  }

  get enFile() {
    return this.file;
  }
  get targetFile() {
    return this.file;
  }
  get referenceFile() {
    return this.refLocale ? this.file : null;
  }

  // "12" -> its slot, or null when the file has no such item.
  private slot(key: string): number | null {
    if (!/^\d{1,3}$/.test(key)) return null;
    const n = Number(key);
    return n < MAX_ITEM_INDEX && this.data.exists(this.slotBase + n) ? this.slotBase + n : null;
  }

  private need(key: string): number {
    const s = this.slot(key);
    if (s === null) throw new AppError("not-editable", `${this.name} has no item ${key}.`, { group: this.name, key });
    return s;
  }

  keys(): string[] {
    return this.data.slots().map((s) => String(s - this.slotBase));
  }

  en(key: string): string | null {
    const s = this.slot(key);
    return s === null ? null : this.data.english(s);
  }

  reference(key: string): string | null {
    const s = this.slot(key);
    if (s === null || !this.refLocale) return null;
    return this.data.nameIn(s, this.refLocale) || null;
  }

  async setReference(locale: string | null): Promise<void> {
    this.refLocale = locale;
  }

  current(key: string): EntryState {
    const s = this.slot(key);
    const v = s === null ? "" : this.data.getName(s);
    return v ? { value: v, comment: null } : null;
  }

  saved(key: string): EntryState {
    const s = this.slot(key);
    const v = s === null ? "" : this.data.originalName(s);
    return v ? { value: v, comment: null } : null;
  }

  apply(key: string, state: EntryState): void {
    this.data.restoreName(this.need(key), state?.value ?? "");
  }

  entryFor(_key: string, _cur: EntryState, text: string): EntryState {
    return { value: text, comment: null };
  }

  keepEntry(key: string): EntryState {
    throw new AppError("not-editable", `Item names cannot be marked "keep".`, { group: this.name, key });
  }

  isKeep = () => false;

  validateText(key: string, text: string): void {
    this.need(key);
    const bad = itemNameIssues(text).find((i) => BLOCKING_ITEM_ISSUES.has(i.code));
    if (bad) throw new AppError("item-name-invalid", `The name for ${this.name} ${key} cannot be used: ${bad.code}.`, { group: this.name, key, code: bad.code });
  }

  check = (en: string, text: string) => checkItemName(en, text);

  meta(): KeyMeta {
    return { legacyIds: [], enLine: 0, line: 0 };
  }

  report(): GroupReport {
    const byKey = new Map<string, RowIssue[]>();
    const counts: Record<Severity, number> = { error: 0, warning: 0, info: 0 };
    let translated = 0;
    let sameAsEn = 0;
    const keys = this.keys();
    for (const key of keys) {
      const value = this.current(key)?.value;
      if (!value) continue;
      translated++;
      const issues = checkItemName(this.en(key) ?? "", value);
      if (!issues.length) continue;
      byKey.set(
        key,
        issues.map((i): RowIssue => (Object.keys(i.params).length ? [i.code, this.locale, i.params] : [i.code, this.locale])),
      );
      for (const i of issues) {
        counts[SEVERITY[i.code]]++;
        if (i.code === "same-as-en") sameAsEn++;
      }
    }
    return { byKey, loose: [], progress: { total: keys.length, translated, sameAsEn, kept: 0, extra: 0 }, counts };
  }

  baseHash(): string {
    const saved = this.data.slots().map((s) => [s, this.data.originalName(s)]).filter(([, n]) => n !== "");
    return sha1(utf8(JSON.stringify(saved)));
  }

  async diskChanged(): Promise<boolean> {
    const onDisk = (await this.st.exists(this.path)) ? new TextDecoder().decode(await this.st.read(this.path)) : null;
    return onDisk !== this.diskText;
  }

  planWrite(keys: string[]): WritePlan {
    const fileName = this.data.fileNames[0]!;
    const text = this.data.changedFiles()[0]?.text ?? this.diskText;
    let check: ItemData;
    try {
      check = ItemData.parse([{ name: fileName, text }], this.locale);
    } catch (e) {
      throw new AppError("save-verify-failed", `Internal error: ${this.file} would not read back (${(e as Error).message}) - save aborted.`, { file: this.file });
    }
    const bad = [...keys, ...this.keys()].find((key) => {
      const s = this.slot(key);
      return s !== null && (check.getName(s) !== this.data.getName(s) || check.english(s) !== this.data.english(s));
    });
    if (bad !== undefined || check.itemCount !== this.data.itemCount) {
      throw new AppError("save-verify-failed", `Internal error: ${this.file} / ${bad ?? "?"} would be written incorrectly - save aborted.`, { file: this.file, key: bad ?? "" });
    }
    return { file: this.file, path: this.path, text, created: false };
  }

  committed(plan: WritePlan): void {
    this.data = ItemData.parse([{ name: this.data.fileNames[0]!, text: plan.text }], this.locale);
    this.diskText = plan.text;
  }
}

// The item files of a Data/Items folder, one group each, in file-name order. Every file is read
// and parsed before returning (ItemJsonError names the broken file).
export async function loadItemsGroups(st: Storage, dir: string, rel: string, locale: string, ref: string | null): Promise<ItemsGroup[]> {
  const out: ItemsGroup[] = [];
  const used = new Set<string>();
  for (const fileName of (await st.list(dir)).filter(isItemFileName).sort()) {
    const path = st.join(dir, fileName);
    const text = new TextDecoder().decode(await st.read(path));
    const data = ItemData.parse([{ name: fileName, text }], locale);
    let name = itemGroupName(data.fileGroup(fileName)!);
    if (used.has(name)) name = `Items.${fileName.replace(/\.json$/i, "")}`; // two files of one group
    used.add(name);
    out.push(new ItemsGroup(st, path, rel ? `${rel}/${fileName}` : fileName, name, locale, ref, data, text));
  }
  return out;
}

// Every locale with a name somewhere in the item files (for the locale choice), per file.
export async function itemLocales(st: Storage, dir: string): Promise<{ file: string; locales: string[] }[]> {
  const out = [];
  for (const fileName of (await st.list(dir)).filter(isItemFileName).sort()) {
    const text = new TextDecoder().decode(await st.read(st.join(dir, fileName)));
    out.push({ file: fileName, locales: ItemData.parse([{ name: fileName, text }]).locales() });
  }
  return out;
}
