// proposals.ts - Proposal files (src/core/proposals.ts) in the side data folder:
//   .mumain-translator/proposals/vi-20261001-103000-a1b2.json         written by the MCP server (one per batch)
//   .mumain-translator/proposals/decisions/vi-20261001-103000-a1b2.json what the person decided, per item
// The writer only adds new files; the tool writes the decisions and removes a proposal file once
// every item in it is decided (its decision file stays, as the history the writer can learn from).

import {
  type Decision,
  type DecisionFile,
  PROPOSAL_VERSION,
  type ProposalFile,
  parseDecisionFile,
  parseProposalFile,
  serializeDecisionFile,
} from "../core";
import { workDir } from "./sidecar";
import { type Storage, readText, tryReadText, writeText } from "./storage";

export const proposalsDir = (st: Storage, folder: string) => st.join(workDir(st, folder), "proposals");
export const decisionsDir = (st: Storage, folder: string) => st.join(proposalsDir(st, folder), "decisions");

export interface LoadedProposal {
  name: string; // file name
  file: ProposalFile;
  decided: Map<number, Decision>; // by item index
}

export interface ProposalScan {
  files: LoadedProposal[]; // of the locale, oldest first
  broken: { name: string; detail: string }[];
}

// Every proposal file for `locale` with what was decided about it so far. Files of other locales
// are skipped; unreadable ones are reported, not thrown.
export async function loadProposals(st: Storage, folder: string, locale: string): Promise<ProposalScan> {
  const dir = proposalsDir(st, folder);
  const files: LoadedProposal[] = [];
  const broken: ProposalScan["broken"] = [];
  for (const name of (await st.list(dir)).filter((n) => n.toLowerCase().endsWith(".json")).sort()) {
    let file: ProposalFile;
    try {
      file = parseProposalFile(await readText(st, st.join(dir, name)));
    } catch (e) {
      broken.push({ name, detail: (e as Error).message });
      continue;
    }
    if (file.locale !== locale) continue;
    const d = parseDecisionFile(await tryReadText(st, st.join(decisionsDir(st, folder), name)));
    files.push({ name, file, decided: new Map((d?.decisions ?? []).map((x) => [x.index, x])) });
  }
  files.sort((a, b) => (a.file.createdAt === b.file.createdAt ? (a.name < b.name ? -1 : 1) : a.file.createdAt < b.file.createdAt ? -1 : 1));
  return { files, broken };
}

// Adds `decisions` to the decision file of `p`; removes the proposal file when nothing in it is left
// undecided. Returns true when it was removed.
export async function recordDecisions(st: Storage, folder: string, p: LoadedProposal, decisions: Decision[]): Promise<boolean> {
  if (!decisions.length) return false;
  const path = st.join(decisionsDir(st, folder), p.name);
  const old = parseDecisionFile(await tryReadText(st, path));
  const byIndex = new Map((old?.decisions ?? []).map((d) => [d.index, d]));
  for (const d of decisions) {
    byIndex.set(d.index, d);
    p.decided.set(d.index, d);
  }
  const out: DecisionFile = {
    version: PROPOSAL_VERSION,
    file: p.name,
    locale: p.file.locale,
    proposedBy: p.file.by,
    createdAt: p.file.createdAt,
    decisions: [...byIndex.values()].sort((a, b) => a.index - b.index),
  };
  await writeText(st, path, serializeDecisionFile(out));
  if (p.file.items.every((_, i) => byIndex.has(i))) {
    await st.remove(st.join(proposalsDir(st, folder), p.name));
    return true;
  }
  return false;
}
