// sheets.ts - The layout the team uses in Google Sheets: one tab per group, downloaded as one CSV
// per tab. Pure format; exported / imported by the Session.
//
//   MuMain_VI_Game.csv   Key, English, Vietnamese[, Status, Note, BaseText]
//   MuMain_VI_Item.csv   ItemType, ItemIndex, English, Vietnamese[, Status, Note, BaseText]
// The translation column is named after the language (any column the reader does not otherwise
// know). Status / Note / BaseText are added at the end by the export (BaseText can be hidden in the
// sheet): with BaseText, importing the tab back tells "changed in the sheet" from a conflict. The
// group of a tab comes from the file name: "MuMain_VI_Game.csv", or "<spreadsheet> - Game.csv" as
// Google Sheets names a downloaded tab.

export const ITEM_TAB = "Item";
export const SHEET_TAIL = ["Status", "Note", "BaseText"] as const;

// "MuMain_VI - Game.csv" / "MuMain_VI_Game.csv" / "Game.tsv" -> "Game".
export function sheetTab(fileName: string): string {
  const base = fileName.replace(/^.*[\\/]/, "").replace(/\.(csv|tsv|txt)$/i, "").trim();
  const dash = base.lastIndexOf(" - ");
  if (dash >= 0) return base.slice(dash + 3).trim();
  const m = /^MuMain_[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,4})?_(.+)$/.exec(base);
  return (m ? m[1]! : base).trim();
}

export const sheetFileName = (locale: string, tab: string) => `MuMain_${locale.toUpperCase().replace(/-/g, "_")}_${tab}.csv`;

// "vi" -> "Vietnamese" (the header of the translation column).
export function languageName(locale: string): string {
  try {
    const name = new Intl.DisplayNames(["en"], { type: "language" }).of(locale);
    if (name && name !== locale) return name;
  } catch {
    // unknown code
  }
  return `Translation (${locale})`;
}

const csvCell = (s: string) => (/[",\r\n]/.test(s) || s.startsWith(" ") || s.endsWith(" ") ? `"${s.replace(/"/g, '""')}"` : s);

// CSV (comma, quoted where needed), UTF-8 with a BOM so Excel reads it as UTF-8 too.
export function serializeCsv(header: readonly string[], rows: readonly string[][]): string {
  return `\uFEFF${[header, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n")}\r\n`;
}
