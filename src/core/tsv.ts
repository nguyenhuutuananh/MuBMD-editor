// tsv.ts - Translation TSV files (Excel / Google Sheets friendly), pure logic.
//
// Columns are matched by header name (case-insensitive), so older files such as
// "ItemType, ItemIndex, Name" or "ItemType, ItemIndex, Status, Name" import too.
// The Name column is the first header starting with "name" (e.g. "Name(Japanese)").

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
  columns: { base: boolean; status: boolean; translator: boolean; note: boolean };
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
  if (h === "reference" || h === "ref" || h === "source") return "reference";
  if (h.startsWith("name")) return "name";
  return null;
}

const cellText = (s: string | undefined) => (s ?? "").trim().normalize("NFC");

export function parseTranslationTsv(text: string): TsvParseResult {
  const lines = text.replace(/^﻿/, "").split(/\r\n|\r|\n/);
  const header = (lines[0] ?? "").split("\t");
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

  lines.slice(1).forEach((raw, i) => {
    const line = i + 2;
    if (!raw.trim()) return;
    const cells = raw.split("\t");
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
    columns: { base: col.has("base"), status: col.has("status"), translator: col.has("translator"), note: col.has("note") },
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
  return `﻿${lines.join("\n")}\n`;
}
