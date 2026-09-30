// proposals.ts - Translations proposed by someone else (an AI assistant through the MCP server, a
// script) for a person to accept or skip in the tool. Pure format; the files live in
// .mumain-translator/proposals/ (see src/session/proposals.ts).
//
// A proposal file is written once, never changed by its writer:
//   {"version":1,"locale":"vi","createdAt":"2026-10-01T10:30:00Z","by":"AI (Claude Code)","note":"...",
//    "items":[{"group":"Items.Helm","key":"1","english":"Dragon Helm","base":"","value":"Mũ Rồng","note":"..."}]}
// `english` and `base` are the English text and the translation ("" = none) the proposal was made
// from, so a proposal made before either changed can be told apart. What the person decided is kept in
// a decision file of the same name (proposals/decisions/<name>); a proposal file whose items are all
// decided is removed.

import { AppError } from "./errors";

export const PROPOSAL_VERSION = 1;

export interface ProposalItem {
  group: string; // "Game", "Items.Helm"...
  key: string; // resx key, or the item number
  english: string;
  base: string; // the translation it was made from ("" = none)
  value: string; // the proposed translation
  note: string; // why / doubts, for the reviewer
}

export interface ProposalFile {
  version: typeof PROPOSAL_VERSION;
  locale: string;
  createdAt: string; // ISO
  by: string; // who / what proposed it
  note: string; // about the whole batch
  items: ProposalItem[];
}

// accepted: taken as proposed; edited: taken after changing it; rejected: skipped (with a reason);
// superseded: a newer proposal for the same key was decided.
export type DecisionAction = "accepted" | "edited" | "rejected" | "superseded";

export interface Decision {
  index: number; // of the item in the proposal file
  group: string;
  key: string;
  english: string;
  proposed: string;
  value: string | null; // the text taken (accepted / edited), else null
  action: DecisionAction;
  reason: string;
  by: string; // the person who decided
  at: string; // ISO
}

export interface DecisionFile {
  version: typeof PROPOSAL_VERSION;
  file: string; // the proposal file name
  locale: string;
  proposedBy: string;
  createdAt: string; // of the proposal
  decisions: Decision[];
}

const invalid = (detail: string) => new AppError("proposal-invalid", `Not a proposal file: ${detail}.`, { detail });
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown) => (typeof v === "string" ? v : "");

// Throws AppError "proposal-invalid" for a file that is not one (bad JSON, unknown version, an item
// without group / key / value).
export function parseProposalFile(json: string): ProposalFile {
  let data: unknown;
  try {
    data = JSON.parse(json.replace(/^\uFEFF/, ""));
  } catch (e) {
    throw invalid((e as Error).message);
  }
  if (!isObj(data)) throw invalid("not a JSON object");
  if (data.version !== PROPOSAL_VERSION) throw invalid(`version ${String(data.version)}`);
  if (typeof data.locale !== "string" || !data.locale) throw invalid("no locale");
  if (!Array.isArray(data.items)) throw invalid("no items");
  const items = data.items.map((it, i): ProposalItem => {
    if (!isObj(it) || typeof it.group !== "string" || typeof it.key !== "string" || typeof it.value !== "string") {
      throw invalid(`item ${i + 1} needs group, key and value`);
    }
    return { group: it.group, key: it.key, english: text(it.english), base: text(it.base), value: it.value, note: text(it.note) };
  });
  return { version: PROPOSAL_VERSION, locale: data.locale, createdAt: text(data.createdAt), by: text(data.by), note: text(data.note), items };
}

export const serializeProposalFile = (p: ProposalFile) => `${JSON.stringify(p, null, 2)}\n`;

// A missing or unreadable decision file = nothing decided yet.
export function parseDecisionFile(json: string | null): DecisionFile | null {
  if (json === null) return null;
  try {
    const data = JSON.parse(json) as DecisionFile;
    return isObj(data) && Array.isArray(data.decisions) ? data : null;
  } catch {
    return null;
  }
}

export const serializeDecisionFile = (d: DecisionFile) => `${JSON.stringify(d, null, 2)}\n`;
