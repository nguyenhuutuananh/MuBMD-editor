// itemData.ts - In-memory model of MuMain's item data folder (Data/Items/Group00_Sword.json ...
// Group15_Etc.json). Each item has its names by language:
//   { "number": 1, "name": { "en": "Short Sword", "es": "Espada Corta", "pt": "Espada curta" }, ... }
// and this tool edits one language (the target locale).
//
// Rule: only the "name" value of renamed items is rewritten, in the form MuMain's own writer uses
// (English first, then the other languages sorted by code, 2-space indent). Every other byte of the
// file stays as it was, and an unedited file is written back byte-for-byte identical.

import { AppError } from "./errors";
import { type JsonNode, JsonSyntaxError, jsonString, member, parseJsonText } from "./jsonText";

export const NEUTRAL_LOCALE = "en";
export const TARGET_LOCALE = "vi";

// Item ids: 16 groups (ItemType) x 512 numbers (ItemIndex); slot = group * 512 + number.
export const MAX_ITEM_TYPE = 16;
export const MAX_ITEM_INDEX = 512;
export const MAX_ITEM = MAX_ITEM_TYPE * MAX_ITEM_INDEX;
export const isSlot = (slot: number) => Number.isInteger(slot) && slot >= 0 && slot < MAX_ITEM;

// Same order as MuMain's ITEM_GROUP_* constants (ItemJsonStorage.cpp).
export const GROUP_FILE_NAMES = [
  "Sword", "Axe", "Mace", "Spear", "Bow", "Staff", "Shield", "Helm",
  "Armor", "Pants", "Gloves", "Boots", "Wing", "Helper", "Potion", "Etc",
] as const;

// The group name of item group `group` in this tool (Session, TSV): "Items.Sword" for 0...
export const itemGroupName = (group: number) => `Items.${GROUP_FILE_NAMES[group] ?? group}`;
export const isItemGroupName = (name: string) => name.startsWith("Items.");

export const groupFileName = (group: number) => `Group${String(group).padStart(2, "0")}_${GROUP_FILE_NAMES[group]}.json`;

// MuMain reads every *.json file of the folder; the group comes from the file's "group" field.
export const isItemFileName = (name: string) => /\.json$/i.test(name);
// What a folder of item files looks like (used to find the folder inside a game folder).
export const looksLikeItemFile = (name: string) => /^Group\d{2}_\w+\.json$/i.test(name);

export class ItemJsonError extends AppError {
  constructor(file: string, detail: string) {
    super("item-json", `${file}: ${detail}`, { file, detail });
  }
}

export class NoItemError extends AppError {
  constructor(slot: number) {
    super("not-editable", `There is no item in slot ${slot}.`, { slot });
  }
}

export interface ItemFileText {
  name: string; // file name, e.g. "Group00_Sword.json"
  text: string;
}

interface Item {
  slot: number;
  file: string;
  node: JsonNode; // the "name" value
  names: Map<string, string>; // locale -> name, as in the file
  indent: string; // indentation of the line holding "name"
  unit: string; // one indentation step
}

interface FileState {
  text: string;
  eol: string;
}

const lineIndent = (text: string, pos: number) => /^[ \t]*/.exec(text.slice(text.lastIndexOf("\n", pos - 1) + 1))![0];

export class ItemData {
  private readonly files = new Map<string, FileState & { group: number }>();
  private readonly items = new Map<number, Item>();
  private readonly changed = new Map<number, string>(); // slot -> new target name ("" = none)

  private constructor(readonly locale: string) {}

  // Throws ItemJsonError for a file MuMain could not load either (bad JSON, missing group / number /
  // name, the same item twice).
  static parse(files: ItemFileText[], locale = TARGET_LOCALE): ItemData {
    const data = new ItemData(locale);
    for (const f of [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) data.addFile(f);
    return data;
  }

  private addFile({ name, text }: ItemFileText) {
    const fail = (detail: string): never => {
      throw new ItemJsonError(name, detail);
    };
    const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
    const offset = text.length - body.length;
    let root: JsonNode;
    try {
      root = parseJsonText(body);
    } catch (e) {
      if (e instanceof JsonSyntaxError) fail(e.message);
      throw e;
    }
    const group = member(root, "group");
    if (group?.kind !== "number" || !Number.isInteger(group.value) || group.value < 0 || group.value >= MAX_ITEM_TYPE) {
      fail(`"group" must be a number from 0 to ${MAX_ITEM_TYPE - 1}`);
    }
    const list = member(root, "items");
    if (list?.kind !== "array") fail('"items" is missing or not a list');

    this.files.set(name, { text, eol: text.includes("\r\n") ? "\r\n" : "\n", group: (group as Extract<JsonNode, { kind: "number" }>).value });
    for (const [i, item] of (list as Extract<JsonNode, { kind: "array" }>).items.entries()) {
      const where = `item ${i + 1}`;
      const num = member(item, "number");
      if (num?.kind !== "number" || !Number.isInteger(num.value) || num.value < 0 || num.value >= MAX_ITEM_INDEX) {
        fail(`${where}: "number" must be a whole number from 0 to ${MAX_ITEM_INDEX - 1}`);
      }
      const n = num as Extract<JsonNode, { kind: "number" }>;
      const node = member(item, "name");
      const names = new Map<string, string>();
      if (node?.kind === "string") names.set(NEUTRAL_LOCALE, node.value);
      else if (node?.kind === "object") {
        for (const [locale, v] of node.entries) {
          if (v.kind !== "string") fail(`item ${n.value}: name.${locale} must be a text`);
          names.set(locale, (v as Extract<JsonNode, { kind: "string" }>).value);
        }
      } else fail(`item ${n.value}: "name" is missing or not a text / object`);

      const slot = (group as Extract<JsonNode, { kind: "number" }>).value * MAX_ITEM_INDEX + n.value;
      const dup = this.items.get(slot);
      if (dup) fail(`item ${n.value} of group ${Math.floor(slot / MAX_ITEM_INDEX)} is also defined in ${dup.file}`);

      const at = (p: number) => p + offset;
      const shifted = { ...node!, start: at(node!.start), end: at(node!.end) } as JsonNode;
      const indent = lineIndent(text, shifted.start);
      const itemIndent = lineIndent(text, at(item.start));
      const unit = indent.length > itemIndent.length && indent.startsWith(itemIndent) ? indent.slice(itemIndent.length) : "  ";
      this.items.set(slot, { slot, file: name, node: shifted, names, indent, unit });
    }
  }

  // ---- read ----

  get fileNames(): string[] {
    return [...this.files.keys()];
  }

  // The group ("group" field) of a file.
  fileGroup(name: string): number | null {
    return this.files.get(name)?.group ?? null;
  }

  // Every locale that has a name somewhere, English included.
  locales(): string[] {
    const set = new Set<string>();
    for (const it of this.items.values()) for (const l of it.names.keys()) set.add(l);
    return [...set];
  }

  get itemCount(): number {
    return this.items.size;
  }

  // Slots that have an item, in slot order.
  slots(): number[] {
    return [...this.items.keys()].sort((a, b) => a - b);
  }

  exists(slot: number): boolean {
    return this.items.has(slot);
  }

  fileOf(slot: number): string | null {
    return this.items.get(slot)?.file ?? null;
  }

  // The English name ("" if the item has none), or null when the slot has no item.
  english(slot: number): string | null {
    const it = this.items.get(slot);
    return it ? (it.names.get(NEUTRAL_LOCALE) ?? "") : null;
  }

  // The name in another language as stored in the file ("" if none).
  nameIn(slot: number, locale: string): string {
    return this.items.get(slot)?.names.get(locale) ?? "";
  }

  // Current name in the target language ("" = not translated, or no item).
  getName(slot: number): string {
    return this.changed.get(slot) ?? this.originalName(slot);
  }

  // The name in the target language in the files as opened.
  originalName(slot: number): string {
    return this.items.get(slot)?.names.get(this.locale) ?? "";
  }

  // Names in the target language (only the non-empty ones), for hashing / comparing.
  targetNames(): [number, string][] {
    return this.slots()
      .map((s): [number, string] => [s, this.getName(s)])
      .filter(([, n]) => n !== "");
  }

  // ---- edit ----

  private item(slot: number): Item {
    const it = isSlot(slot) ? this.items.get(slot) : undefined;
    if (!it) throw new NoItemError(slot);
    return it;
  }

  // NoItemError for a slot without an item. "" removes the translation (the game then shows the
  // English name). Stored in NFC; checking the name is up to the caller (itemName.ts).
  setName(slot: number, name: string): void {
    const it = this.item(slot);
    const next = name.normalize("NFC");
    if (next === (it.names.get(this.locale) ?? "")) this.changed.delete(slot);
    else this.changed.set(slot, next);
  }

  // Put back a name read earlier with getName (undo / redo) - not validated, so a name that came
  // from the files as-is (even an over-long one) can be restored exactly.
  restoreName(slot: number, name: string): void {
    const it = this.item(slot);
    if (name === (it.names.get(this.locale) ?? "")) this.changed.delete(slot);
    else this.changed.set(slot, name);
  }

  // Back to the name in the files as opened.
  revert(slot: number): void {
    this.changed.delete(slot);
  }

  get dirtySlots(): number[] {
    return [...this.changed.keys()].sort((a, b) => a - b);
  }

  get isDirty(): boolean {
    return this.changed.size > 0;
  }

  // ---- write ----

  // MuMain's WriteNames(): English first, then the translations sorted by locale.
  private nameText(it: Item, target: string, eol: string): string {
    const names = new Map(it.names);
    if (target) names.set(this.locale, target);
    else names.delete(this.locale);
    const en = names.get(NEUTRAL_LOCALE) ?? "";
    names.delete(NEUTRAL_LOCALE);
    const pairs: [string, string][] = [[NEUTRAL_LOCALE, en], ...[...names].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))];
    const inner = it.indent + it.unit;
    return `{${eol}${pairs.map(([k, v]) => `${inner}${jsonString(k)}: ${jsonString(v)}`).join(`,${eol}`)}${eol}${it.indent}}`;
  }

  // The files with renamed items, with only those names rewritten.
  changedFiles(): ItemFileText[] {
    const byFile = new Map<string, Item[]>();
    for (const slot of this.changed.keys()) {
      const it = this.items.get(slot)!;
      byFile.set(it.file, [...(byFile.get(it.file) ?? []), it]);
    }
    const out: ItemFileText[] = [];
    for (const [name, items] of byFile) {
      const f = this.files.get(name)!;
      let text = f.text;
      for (const it of items.sort((a, b) => b.node.start - a.node.start)) {
        text = text.slice(0, it.node.start) + this.nameText(it, this.changed.get(it.slot)!, f.eol) + text.slice(it.node.end);
      }
      out.push({ name, text });
    }
    return out.sort((a, b) => (a.name < b.name ? -1 : 1));
  }

  // Original text of a file (for tests / verification).
  fileText(name: string): string | null {
    return this.files.get(name)?.text ?? null;
  }
}
