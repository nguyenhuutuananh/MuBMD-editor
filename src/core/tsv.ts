// tsv.ts - Translation TSV files exchanged between translators (Excel / Google Sheets friendly),
// pure logic. CSV is read too.
//
// Columns (matched by header name, case-insensitive; order does not matter):
//   Group, Key, English, Translation, Status, Translator, UpdatedAt, BaseText, Note
// Group + Key identify the row; Translation is required, the rest is optional. "BaseText" is the
// translation the sender started from (for the 3-way merge, see merge.ts). A cell holding a tab,
// a line break or a quote is quoted Excel-style, so every text survives the round trip.

import { AppError } from "./errors";
import { MAX_ITEM_INDEX, MAX_ITEM_TYPE, itemGroupName } from "./itemData";

export const STATUSES = ["untranslated", "translated", "reviewed"] as const;
export type Status = (typeof STATUSES)[number];
export const isStatus = (v: unknown): v is Status => STATUSES.includes(v as Status);
export const statusRank = (s: Status): number => STATUSES.indexOf(s);

export interface TsvRow {
  line: number; // 1-based line number in the file (for messages)
  group: string;
  key: string;
  english?: string;
  value: string; // NFC; "" when the cell is empty
  status?: Status;
  translator?: string;
  updatedAt?: string;
  base?: string; // BaseText (present when the column exists, "" = the sender had no translation)
  note?: string;
}

export interface TsvProblem {
  line: number;
  code: "missing-key" | "duplicate";
  detail: string;
}

export interface TsvParseResult {
  rows: TsvRow[];
  problems: TsvProblem[];
  columns: { base: boolean; status: boolean; translator: boolean; note: boolean };
}

export const EXPORT_COLUMNS = ["Group", "Key", "English", "Translation", "Status", "Translator", "UpdatedAt", "BaseText", "Note"] as const;

type Field = "group" | "key" | "english" | "value" | "status" | "translator" | "updatedAt" | "base" | "note";

function fieldOf(header: string): Field | null {
  const h = header.trim().toLowerCase().replace(/[\s_-]/g, "");
  if (h === "group" || h === "file") return "group";
  if (h === "key" || h === "name") return "key";
  if (h === "english" || h === "en" || h === "source") return "english";
  if (h === "translation" || h === "value" || h === "text" || h === "tiengviet" || h === "vietnamese") return "value";
  if (h === "status") return "status";
  if (h === "translator") return "translator";
  if (h === "updatedat") return "updatedAt";
  if (h === "basetext" || h === "base" || h === "origin") return "base";
  if (h === "note" || h === "notes") return "note";
  return null;
}

// Split a TSV or CSV text into rows of cells. The delimiter is a tab if the first line has one,
// otherwise a comma. A cell starting with '"' is quoted Excel-style ("" = a literal quote, may span lines).
// (Same as MuBMD-editor's, so both tools read the same files the same way.)
export function parseDelimited(text: string): string[][] {
  const src = text.replace(/^﻿/, "");
  const firstLine = src.slice(0, src.search(/\r|\n|$/));
  const delim = firstLine.includes("\t") ? "\t" : ",";
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let i = 0;
  let atCellStart = true;
  while (i < src.length) {
    const c = src[i]!;
    if (atCellStart && c === '"') {
      // quoted cell
      i++;
      while (i < src.length) {
        if (src[i] === '"') {
          if (src[i + 1] === '"') {
            cell += '"';
            i += 2;
            continue;
          }
          i++;
          break;
        }
        cell += src[i++];
      }
      atCellStart = false;
      continue;
    }
    if (c === delim) {
      row.push(cell);
      cell = "";
      atCellStart = true;
      i++;
    } else if (c === "\r" || c === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      atCellStart = true;
      i += c === "\r" && src[i + 1] === "\n" ? 2 : 1;
    } else {
      cell += c;
      atCellStart = false;
      i++;
    }
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

const nfc = (s: string | undefined) => (s ?? "").normalize("NFC");
const short = (s: string | undefined) => nfc(s).trim();

// A file of the item editor MuBMD-editor (ItemType, ItemIndex, Name, Status, Translator, UpdatedAt,
// BaseName, Reference, Note), the team sheet's Item tab (ItemType, ItemIndex, English or the old
// Nguon, Vietnamese / TiengViet): read as rows of the item groups ("Items.Sword" / "12"). Only a
// column named English is the English name: Nguon (the Japanese name of the old Item.bmd) and
// Reference (another locale) are not, and would make every row look outdated.
function itemColumns(header: string[]): Map<Field, number> | null {
  const norm = header.map((h) => h.trim().toLowerCase().replace(/[\s_-]/g, ""));
  const type = norm.indexOf("itemtype");
  const index = norm.indexOf("itemindex");
  if (type < 0 || index < 0 || norm.includes("group")) return null;
  const col = new Map<Field, number>([
    ["group", type],
    ["key", index],
  ]);
  const map: Record<string, Field> = {
    basename: "base",
    basetext: "base",
    base: "base",
    english: "english",
    en: "english",
    status: "status",
    translator: "translator",
    updatedat: "updatedAt",
    note: "note",
    notes: "note",
  };
  norm.forEach((h, i) => {
    const f = h.startsWith("name") || h === "tiengviet" || h === "vietnamese" || h === "translation" ? "value" : map[h];
    if (f && !col.has(f)) col.set(f, i);
  });
  return col;
}

// ItemType / ItemIndex cells of an item file -> the group name + key, or null when out of range.
function itemRef(type: string, index: string): [string, string] | null {
  const t = Number(type.trim());
  const i = Number(index.trim());
  if (!Number.isInteger(t) || t < 0 || t >= MAX_ITEM_TYPE || !Number.isInteger(i) || i < 0 || i >= MAX_ITEM_INDEX) return null;
  return [itemGroupName(t), String(i)];
}

// `defaultGroup`: a Google Sheets tab without a Group column (sheets.ts): every row is of this
// group, and a column the reader does not know is the translation (it is named after the language).
export function parseTranslationTsv(text: string, opts: { defaultGroup?: string } = {}): TsvParseResult {
  const table = parseDelimited(text);
  const header = table[0] ?? [];
  const items = itemColumns(header);
  const col = items ?? new Map<Field, number>();
  if (!items) {
    header.forEach((h, i) => {
      const f = fieldOf(h);
      if (f && !col.has(f)) col.set(f, i);
    });
  }
  const tabGroup = !items && !col.has("group") && opts.defaultGroup ? opts.defaultGroup : null;
  if (tabGroup && !col.has("value")) {
    const i = header.findIndex((h) => h.trim() !== "" && fieldOf(h) === null);
    if (i >= 0) col.set("value", i);
  }
  if ((!col.has("group") && !tabGroup) || !col.has("key") || !col.has("value")) {
    throw new AppError("tsv-header", `The header must contain Group, Key and Translation columns (got: ${header.join(", ")}).`, {
      columns: header.join(", "),
    });
  }

  const rows: TsvRow[] = [];
  const problems: TsvProblem[] = [];
  const byId = new Map<string, number>(); // group + key -> index in rows
  const get = (cells: string[], f: Field) => (col.has(f) ? cells[col.get(f)!] : undefined);
  const opt = (cells: string[], f: Field) => (col.has(f) ? short(get(cells, f)) : undefined);

  table.slice(1).forEach((cells, i) => {
    const line = i + 2;
    if (!cells.join("").trim()) return;
    // Keys and texts are kept exactly (leading / trailing spaces can matter in game texts).
    let group = tabGroup ?? short(get(cells, "group"));
    let key = nfc(get(cells, "key"));
    if (items) [group, key] = itemRef(group, key) ?? ["", ""];
    if (!group || !key) {
      problems.push({ line, code: "missing-key", detail: `${group}/${key}` });
      return;
    }
    const status = opt(cells, "status")?.toLowerCase();
    const row: TsvRow = {
      line,
      group,
      key,
      english: col.has("english") ? nfc(get(cells, "english")) : undefined,
      value: nfc(get(cells, "value")),
      status: isStatus(status) ? status : undefined,
      translator: opt(cells, "translator") || undefined,
      updatedAt: opt(cells, "updatedAt") || undefined,
      base: col.has("base") ? nfc(get(cells, "base")) : undefined,
      note: opt(cells, "note"),
    };
    const id = `${group}\u0000${key}`;
    const prev = byId.get(id);
    if (prev !== undefined) {
      problems.push({ line, code: "duplicate", detail: `${group}/${key}` });
      rows[prev] = row; // the last row for a key wins
    } else {
      byId.set(id, rows.length);
      rows.push(row);
    }
  });

  return {
    rows,
    problems,
    columns: { base: col.has("base"), status: col.has("status"), translator: col.has("translator"), note: col.has("note") },
  };
}

export interface ExportRow {
  group: string;
  key: string;
  english: string;
  value: string; // "" = not translated
  status: Status;
  translator: string;
  updatedAt: string;
  base: string;
  note: string;
}

// Excel-style quoting, only where needed.
const cell = (s: string) => (/[\t\r\n"]/.test(s) || s.startsWith(" ") || s.endsWith(" ") ? `"${s.replace(/"/g, '""')}"` : s);

// UTF-8 with BOM so Excel on Windows detects the encoding (Vietnamese would be garbled otherwise).
export function serializeTranslationTsv(rows: ExportRow[]): string {
  const lines = [EXPORT_COLUMNS.join("\t")];
  for (const r of rows) {
    lines.push([r.group, r.key, r.english, r.value, r.status, r.translator, r.updatedAt, r.base, r.note].map(cell).join("\t"));
  }
  return `﻿${lines.join("\n")}\n`;
}
