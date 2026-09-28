// tsv.ts - Translation TSV files (Excel / Google Sheets friendly), pure logic. CSV is read too.
//
// Columns are matched by header name (case-insensitive), so older files such as
// "ItemType, ItemIndex, Name" or "ItemType, ItemIndex, Status, Name" import too.
// The Name column is the first header starting with "name" (e.g. "Name(Japanese)"), or
// "TiengViet" / "Vietnamese"; "Nguon" / "Source" / "Original" is the reference (source) column.

import { AppError } from "./errors";
import { MAX_ITEM_INDEX, MAX_ITEM_TYPE } from "./format";

export const STATUSES = ["untranslated", "translated", "reviewed"] as const;
export type Status = (typeof STATUSES)[number];
export const isStatus = (v: unknown): v is Status => STATUSES.includes(v as Status);
export const statusRank = (s: Status): number => STATUSES.indexOf(s);

export interface TsvRow {
  line: number; // 1-based line number in the file (for error messages)
  itemType: number;
  itemIndex: number;
  slot: number;
  name: string; // NFC-normalized; "" when the cell is empty
  status?: Status;
  translator?: string;
  updatedAt?: string;
  note?: string;
  base?: string; // BaseName: the name the translator started from (for 3-way merge)
  reference?: string;
}

export interface TsvProblem {
  line: number;
  code: "bad-slot" | "duplicate";
  detail: string;
}

export interface TsvParseResult {
  rows: TsvRow[];
  problems: TsvProblem[];
  columns: { base: boolean; status: boolean; translator: boolean; note: boolean; reference: boolean };
}

export const EXPORT_COLUMNS = [
  "ItemType",
  "ItemIndex",
  "Name",
  "Status",
  "Translator",
  "UpdatedAt",
  "BaseName",
  "Reference",
  "Note",
] as const;

type Field = "itemType" | "itemIndex" | "name" | "status" | "translator" | "updatedAt" | "note" | "base" | "reference";

function fieldOf(header: string): Field | null {
  const h = header.trim().toLowerCase().replace(/[\s_-]/g, "");
  if (h === "itemtype" || h === "type") return "itemType";
  if (h === "itemindex" || h === "index") return "itemIndex";
  if (h === "status") return "status";
  if (h === "translator") return "translator";
  if (h === "updatedat") return "updatedAt";
  if (h === "note" || h === "notes") return "note";
  if (h === "basename" || h === "base" || h === "origin") return "base";
  if (["reference", "ref", "source", "nguon", "original"].includes(h)) return "reference";
  if (h.startsWith("name") || h === "tiengviet" || h === "vietnamese") return "name";
  return null;
}

// Split a TSV or CSV text into rows of cells. The delimiter is a tab if the first line has one,
// otherwise a comma. A cell starting with '"' is quoted Excel-style ("" = a literal quote, may span lines).
export function parseDelimited(text: string): string[][] {
  const src = text.replace(/^\uFEFF/, "");
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

const cellText = (s: string | undefined) => (s ?? "").trim().normalize("NFC");

export function parseTranslationTsv(text: string): TsvParseResult {
  const table = parseDelimited(text);
  const header = table[0] ?? [];
  const col = new Map<Field, number>();
  header.forEach((h, i) => {
    const f = fieldOf(h);
    if (f && !col.has(f)) col.set(f, i);
  });
  if (!col.has("itemType") || !col.has("itemIndex") || !col.has("name")) {
    throw new AppError("tsv-header", `TSV header must contain ItemType, ItemIndex and Name columns (got: ${header.join(", ")}).`, {
      columns: header.join(", "),
    });
  }

  const rows: TsvRow[] = [];
  const problems: TsvProblem[] = [];
  const bySlot = new Map<number, number>(); // slot -> index in rows
  const get = (cells: string[], f: Field) => (col.has(f) ? cells[col.get(f)!] : undefined);

  table.slice(1).forEach((cells, i) => {
    const line = i + 2;
    if (!cells.join("").trim()) return;
    const t = Number(cellText(get(cells, "itemType")));
    const x = Number(cellText(get(cells, "itemIndex")));
    const validType = Number.isInteger(t) && t >= 0 && t < MAX_ITEM_TYPE;
    const validIndex = Number.isInteger(x) && x >= 0 && x < MAX_ITEM_INDEX;
    if (!validType || !validIndex) {
      problems.push({ line, code: "bad-slot", detail: `${get(cells, "itemType") ?? ""}:${get(cells, "itemIndex") ?? ""}` });
      return;
    }
    const status = cellText(get(cells, "status")).toLowerCase();
    const opt = (f: Field) => (col.has(f) ? cellText(get(cells, f)) : undefined);
    const row: TsvRow = {
      line,
      itemType: t,
      itemIndex: x,
      slot: t * MAX_ITEM_INDEX + x,
      // Keep inner spaces as typed; only strip a trailing \r-like whitespace at the ends.
      name: (get(cells, "name") ?? "").replace(/^\s+|\s+$/g, "").normalize("NFC"),
      status: isStatus(status) ? status : undefined,
      translator: opt("translator") || undefined,
      updatedAt: opt("updatedAt") || undefined,
      note: opt("note"),
      base: col.has("base") ? (get(cells, "base") ?? "").replace(/^\s+|\s+$/g, "").normalize("NFC") : undefined,
      reference: opt("reference") || undefined,
    };
    const prev = bySlot.get(row.slot);
    if (prev !== undefined) {
      problems.push({ line, code: "duplicate", detail: `${t}:${x}` });
      rows[prev] = row; // the last row for a slot wins
    } else {
      bySlot.set(row.slot, rows.length);
      rows.push(row);
    }
  });

  return {
    rows,
    problems,
    columns: {
      base: col.has("base"),
      status: col.has("status"),
      translator: col.has("translator"),
      note: col.has("note"),
      reference: col.has("reference"),
    },
  };
}

export interface ExportRow {
  itemType: number;
  itemIndex: number;
  name: string;
  status: Status;
  translator: string;
  updatedAt: string;
  base: string;
  reference: string;
  note: string;
}

const clean = (s: string) => s.replace(/[\t\r\n]+/g, " ");

// UTF-8 with BOM so Excel on Windows detects the encoding (Vietnamese would be garbled otherwise).
export function serializeTranslationTsv(rows: ExportRow[]): string {
  const lines = [EXPORT_COLUMNS.join("\t")];
  for (const r of rows) {
    lines.push(
      [r.itemType, r.itemIndex, r.name, r.status, r.translator, r.updatedAt, r.base, r.reference, r.note].map((v) => clean(String(v))).join("\t"),
    );
  }
  return `\uFEFF${lines.join("\n")}\n`;
}
