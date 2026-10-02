// actions.ts - User flows: choose a folder, pick the locale, open, reload; edit / keep / revert,
// status / note, undo, save (with conflicts), the draft; TSV export / import, the glossary; AI
// proposals; selection and keyboard shortcuts.

import { ref, shallowRef } from "vue";
import { toast } from "vue-sonner";
import { SEVERITY } from "../../../src/core/validate";
import type { DraftInfo, GlossaryEntry, ImportPreview, KeyRef, ProposalDecision, ProposalRow, SaveRequest, Status } from "../../../src/shared/api";
import { currentLang, errorText, fmtTime, tr } from "@/i18n";
import { ApiError, api, isFallback, isWeb } from "@/lib/api";
import type { OpenOptions } from "@/lib/backend";
import { announceOpen } from "@/lib/tabs";
import { ask, isDialogOpen } from "@/lib/dialogs";
import { type Row, glossaryProblems } from "@/lib/rows";
import { type RecentEntry, useDocStore } from "@/stores/doc";

export const welcomeError = ref<string | null>(null);
export const exportOpen = ref(false);
export const importPreview = shallowRef<ImportPreview | null>(null);
export const glossaryOpen = ref(false);
export const registrationOpen = ref(false);
export const anyDialogOpen = () =>
  isDialogOpen.value || exportOpen.value || importPreview.value !== null || glossaryOpen.value || registrationOpen.value;

// RowGrid registers a function that scrolls to a row (by index in the filtered list).
let scroller: ((index: number) => void) | null = null;
export function registerScroller(fn: ((index: number) => void) | null) {
  scroller = fn;
}

// RowToolbar registers how to focus the search box (Ctrl+F).
let searchFocus: (() => void) | null = null;
export function registerSearch(fn: (() => void) | null) {
  searchFocus = fn;
}

const store = () => useDocStore();
const visibleIndex = (id: number) => store().visible.findIndex((r) => r.id === id);

export function select(id: number | null, scroll = false) {
  const s = store();
  s.selectedId = id;
  if (scroll && id !== null) {
    const i = visibleIndex(id);
    if (i >= 0) scroller?.(i);
  }
}

// ---- welcome / open ----

export function showWelcome() {
  store().editor = null;
  store().listing = null;
  store().view = "welcome";
}

export function backToFolder() {
  welcomeError.value = null;
  store().listing = null;
  store().view = "workspace";
}

// Step 1: a folder (typed, picked, or recent) -> the list of its locales.
export async function scanPath(path: string) {
  welcomeError.value = null;
  try {
    await store().scan(path);
  } catch (e) {
    welcomeError.value = errorText(e);
  }
}

export async function pickFolder() {
  welcomeError.value = null;
  try {
    const { path } = await api.pick(currentLang());
    if (path) await scanPath(path);
  } catch (e) {
    welcomeError.value = errorText(e);
  }
}

async function confirmDiscard(): Promise<boolean> {
  const n = store().status.dirtyCount;
  const r = await ask({
    title: tr("discardDialog.title"),
    body: [tr("discardDialog.body", { n })],
    actions: [
      { id: "cancel", label: tr("discardDialog.back") },
      { id: "discard", label: tr("discardDialog.discard"), kind: "danger" },
    ],
  });
  return r.action === "discard";
}

// Step 2 (or a recent entry): open for translating `locale`; `create` for a new language, `name`
// its display name (kept for this folder).
export async function openFolder(path: string, locale: string, reference: string | null, opts: OpenOptions = {}): Promise<void> {
  const create = opts.create === true;
  welcomeError.value = null;
  try {
    const draft = await store().openFolder(path, locale, reference, opts);
    // Web: each tab keeps its own copy of the folder in memory.
    const opened = store().open;
    const m = opened?.migrated;
    if (m) toast.info(tr("toast.migrated", { from: m.from.join(", "), n: m.records, draft: m.draftEdits }), { duration: 15000 });
    if (isWeb && opened) announceOpen(`${opened.folder.path}|${opened.locale}`, () => toast.warning(tr("toast.otherTab"), { duration: 15000 }));
    if (draft) await offerDraft(draft);
    const isNew = !store().open?.folder.locales.some((l) => l.code === locale);
    if (create && isNew) toast.info(tr("toast.newLocale", { locale }), { duration: 10000 });
  } catch (e) {
    if (e instanceof ApiError && e.code === "dirty") {
      if (await confirmDiscard()) return openFolder(path, locale, reference, { ...opts, discard: true });
      return;
    }
    if (e instanceof ApiError && e.code === "locale-code") {
      welcomeError.value = errorText(e); // stay on the locale choice
      return;
    }
    showWelcome();
    welcomeError.value = errorText(e);
  }
}

// A recent entry may be a language whose files were never saved: open it as new again.
export const openRecent = (r: RecentEntry) => openFolder(r.path, r.locale, r.reference, { create: true });

// The locale choice (step 2) of a recent folder, instead of opening it with its last locale.
export function chooseRecentLocale(r: RecentEntry) {
  return scanPath(r.path);
}

// Translate another locale of the folder open now (or rename this one): back to the locale choice.
export async function changeLocale() {
  const s = store();
  const open = s.open;
  if (!open || !(await commitEditor())) return;
  s.editor = null;
  s.view = "welcome";
  await scanPath(open.folder.path);
}

// Read the files again; unsaved edits are put back on top of what is on disk now.
export async function reload() {
  if (!(await commitEditor())) return;
  try {
    const res = await store().rebase();
    await store().loadRows();
    if (res.conflicts.length) {
      toast.warning(tr("toast.rebaseConflicts", { n: res.conflicts.length, keys: res.conflicts.map((c) => c.key).join(", ") }), { duration: 15000 });
    } else if (res.changedFiles.length) {
      toast.info(tr("toast.reloadedChanged", { files: res.changedFiles.join(", ") }));
    } else {
      toast(tr("toast.reloaded"));
    }
  } catch (e) {
    toast.error(errorText(e));
  }
}

export async function setReference(locale: string | null) {
  try {
    await store().setReference(locale);
  } catch (e) {
    toast.error(errorText(e));
  }
}

// On startup: if the server already has a folder open (path on the command line), go straight to it.
export async function start() {
  // The team glossary is remembered per browser (one file for every folder).
  const g = store().rememberedGlossary();
  if (g) store().loadGlossary(g).catch((e) => toast.error(errorText(e)));
  try {
    const state = await api.state();
    if (state.open) {
      const draft = await store().loadRows();
      if (draft) await offerDraft(draft);
    }
  } catch (e) {
    welcomeError.value = errorText(e);
  }
}

async function offerDraft(d: DraftInfo) {
  const body = [tr("draftDialog.body", { n: d.count, time: fmtTime(d.savedAt) })];
  if (d.translators.length) body.push(tr("draftDialog.who", { names: d.translators.join(", ") }));
  const r = await ask({
    title: tr("draftDialog.title"),
    body,
    actions: [
      { id: "discard", label: tr("draftDialog.discard"), kind: "danger" },
      { id: "restore", label: tr("draftDialog.restore"), kind: "primary" },
    ],
  });
  try {
    if (r.action === "restore") {
      const res = await store().restoreDraft();
      const msg = [tr("toast.restored", { n: res.changed.length })];
      if (res.skipped) msg.push(tr("toast.restoredSkipped", { n: res.skipped }));
      toast.success(msg.join(" "));
    } else if (r.action === "discard") {
      await store().discardDraft();
    }
  } catch (e) {
    toast.error(errorText(e));
  }
}

// ---- translator ----

export async function askTranslator(): Promise<boolean> {
  const r = await ask({
    title: tr("translatorDialog.title"),
    body: [tr("translatorDialog.body")],
    input: { label: tr("translatorDialog.label"), value: store().translator, placeholder: tr("translatorDialog.placeholder"), required: true },
    actions: [
      { id: "cancel", label: tr("common.cancel") },
      { id: "ok", label: tr("translatorDialog.save"), kind: "primary" },
    ],
  });
  if (r.action !== "ok" || !r.value) return false;
  store().setTranslator(r.value);
  return true;
}

const ensureTranslator = async () => Boolean(store().translator) || askTranslator();

// ---- edit ----

// Rows without English text (keys only the translation has) cannot get new text.
export const canEdit = (r: Row) => r.en !== null;
// "Keep English" exists for the UI strings (resx), not for item names.
export const canKeep = (r: Row) => canEdit(r) && store().groups[r.group]?.canKeep === true;

// `proposal`: start from an AI proposal's text; saving accepts the proposal with the edited text.
export async function startEdit(id: number, proposal?: ProposalRow) {
  const s = store();
  const row = s.rows[id];
  if (!row || !canEdit(row) || visibleIndex(id) < 0) return;
  if (!(await ensureTranslator())) return;
  select(id, true);
  const initial = row.value ?? "";
  s.editor = proposal ? { id, value: proposal.value, initial, proposal: { file: proposal.file, index: proposal.index } } : { id, value: initial, initial };
}

export function cancelEdit() {
  store().editor = null;
}

// Returns true if the editor is closed (saved, or nothing changed). An emptied field removes the
// translation (the game shows English).
export async function commitEditor(): Promise<boolean> {
  const s = store();
  const ed = s.editor;
  if (!ed) return true;
  const row = s.rows[ed.id];
  // An emptied proposal is not accepted (it stays undecided).
  if (!row || (ed.proposal ? ed.value === "" : ed.value === ed.initial)) {
    if (s.editor === ed) s.editor = null;
    return true;
  }
  try {
    if (ed.proposal) await decide([{ ...ed.proposal, action: "accept", value: ed.value }]);
    else await s.edit(row, ed.value === "" ? null : ed.value);
    if (s.editor === ed) s.editor = null;
    return true;
  } catch (e) {
    toast.error(errorText(e));
    return false;
  }
}

export async function moveEdit(step: number) {
  const s = store();
  const ed = s.editor;
  if (!ed) return;
  const from = visibleIndex(ed.id);
  if (!(await commitEditor())) return;
  // Skip rows that cannot be edited.
  for (let i = from + step; i >= 0 && i < s.visible.length; i += step) {
    const next = s.visible[i]!;
    if (canEdit(next)) return startEdit(next.id);
  }
}

async function rowAction(id: number, fn: (r: Row) => Promise<unknown>) {
  const row = store().rows[id];
  if (!row || !(await ensureTranslator())) return;
  if (!(await commitEditor())) return;
  try {
    await fn(store().rows[id]!);
  } catch (e) {
    toast.error(errorText(e));
  }
}

export const toggleKeep = (id: number) => {
  const row = store().rows[id];
  if (row && canKeep(row)) return rowAction(id, (r) => store().keep(r, !r.keep));
};
export const removeTranslation = (id: number) => rowAction(id, (r) => store().edit(r, null));
export const revert = (id: number) => rowAction(id, (r) => store().revert(r));

// ---- status / note ----

export async function setStatus(rows: Row[], status: Status) {
  if (!rows.length || !(await ensureTranslator())) return;
  if (!(await commitEditor())) return;
  try {
    const res = await store().setStatus(rows, status);
    if (rows.length > 1) toast.success(tr("toast.statusSet", { n: res.changed.length, status: tr(`status.${status}`) }));
  } catch (e) {
    toast.error(errorText(e));
  }
}

export async function setNote(id: number, note: string) {
  const row = store().rows[id];
  if (!row || !(await ensureTranslator())) return;
  try {
    await store().setNote(row, note);
  } catch (e) {
    toast.error(errorText(e));
  }
}

export async function undoRedo(which: "undo" | "redo") {
  if (!(await commitEditor())) return;
  try {
    const res = await (which === "undo" ? store().undo() : store().redo());
    const t = res.changed[0];
    const r = t ? store().rows.find((x) => x.group === t[0] && x.key === t[1]) : undefined;
    if (r && visibleIndex(r.id) >= 0) select(r.id, true);
  } catch (e) {
    toast.error(errorText(e));
  }
}

// ---- save ----

export async function saveAll(opts: SaveRequest = {}): Promise<void> {
  if (!(await commitEditor())) return;
  try {
    const res = await store().save(opts);
    // "Unsaved changes" would now list nothing: show every row again.
    if (store().filter.state === "dirty") store().filter.state = "any";
    await store().loadRows();
    if (!res.savedCount) {
      toast(tr("toast.nothingToSave"));
      return;
    }
    const lines = [tr("toast.savedFiles", { files: res.files.join(", ") })];
    if (res.created.length) lines.push(tr("toast.created", { files: res.created.join(", ") }));
    if (isFallback && res.files.length) lines.push(tr(res.files.length > 1 ? "toast.downloadedZip" : "toast.downloaded", { n: res.files.length }));
    else if (res.backups.length) lines.push(tr("toast.backups", { n: res.backups.length }));
    toast.success(tr("toast.saved", { n: res.savedCount }), { description: lines.join(" "), duration: 8000 });
  } catch (e) {
    if (e instanceof ApiError && e.code === "conflict") return resolveConflict(String(e.params.files ?? ""));
    toast.error(tr("toast.saveFailed", { reason: errorText(e) }), { duration: 10000 });
  }
}

// Files changed on disk (git pull, Drive, another editor): merge our edits into them, or overwrite.
async function resolveConflict(files: string): Promise<void> {
  const r = await ask({
    title: tr("conflictDialog.title"),
    body: [tr("conflictDialog.body", { files }), tr("conflictDialog.hint")],
    actions: [
      { id: "cancel", label: tr("common.cancel") },
      { id: "force", label: tr("conflictDialog.force"), kind: "danger" },
      { id: "merge", label: tr("conflictDialog.merge"), kind: "primary" },
    ],
  });
  if (r.action === "force") return saveAll({ force: true });
  if (r.action !== "merge") return;
  try {
    const res = await store().rebase();
    await store().loadRows();
    if (res.conflicts.length) {
      // Both sides changed the same keys: let the user look before writing.
      toast.warning(tr("toast.rebaseConflicts", { n: res.conflicts.length, keys: res.conflicts.map((c) => c.key).join(", ") }), { duration: 15000 });
      return;
    }
    await saveAll();
  } catch (e) {
    toast.error(errorText(e));
  }
}

// ---- TSV export / import ----

// Rows "I changed": last touched by me and different from the merge base.
export function myRows(): Row[] {
  const s = store();
  const me = s.translator;
  if (!me) return [];
  return s.rows.filter((r) => r.record?.translator === me && r.record.origin !== undefined && r.record.origin !== (r.value ?? ""));
}

export async function exportTsv(rows: Row[]) {
  if (!(await commitEditor())) return;
  const s = store();
  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  const who = (s.translator || "export").replace(/[^\p{L}\p{N}_-]+/gu, "_");
  try {
    const { path } = await api.pickSave(currentLang(), "tsv", `MuMain-${s.open?.locale ?? ""}-${who}-${ymd}.tsv`);
    if (!path) return;
    const res = await api.exportTsv(path, rows.map((r) => s.refOf(r)));
    exportOpen.value = false;
    toast.success(tr("toast.exported", { n: res.count, file: res.path.split(/[\\/]/).pop() ?? res.path }), { duration: 8000 });
  } catch (e) {
    toast.error(errorText(e));
  }
}

export async function startImport() {
  if (!(await commitEditor())) return;
  try {
    const { path } = await api.pick(currentLang(), "tsv");
    if (!path) return;
    importPreview.value = await api.importPreview(path);
  } catch (e) {
    toast.error(errorText(e));
  }
}

// `glossary`: also use the glossary of the package (written to the side data folder, then loaded).
export async function applyImport(take: KeyRef[], opts: { glossary?: boolean } = {}) {
  const p = importPreview.value;
  if (!p || !(await ensureTranslator())) return;
  try {
    const res = take.length ? await store().importApply(p.path, p.token, take) : null;
    if (opts.glossary) {
      const { path } = await api.packageGlossary(p.path, p.token);
      const g = await store().loadGlossary(path);
      toast.success(tr("toast.glossaryLoaded", { file: g.fileName, n: g.entries.length }));
    }
    importPreview.value = null;
    if (!res) return;
    toast.success(tr("toast.imported", { n: res.changed.length }), { duration: 8000 });
    // Show what came in, for review before saving.
    store().filter.query = "";
    store().filter.state = "dirty";
  } catch (e) {
    toast.error(errorText(e));
    if (e instanceof ApiError && e.code === "import-changed") importPreview.value = null;
  }
}

// ---- translation package (.zip) ----

// Everything of the locale in one ZIP to share: the translations as a TSV (imported with the merge),
// the saved files (to unzip over the same MuMain version), the loaded glossary. Unsaved edits are
// saved first (the package holds what is on disk).
export async function exportPackage() {
  if (!(await ensureTranslator()) || !(await commitEditor())) return;
  const s = store();
  if (s.status.dirtyCount) {
    const r = await ask({
      title: tr("packageDialog.saveTitle"),
      body: [tr("packageDialog.saveBody", { n: s.status.dirtyCount })],
      actions: [
        { id: "cancel", label: tr("common.cancel") },
        { id: "save", label: tr("packageDialog.saveAndExport"), kind: "primary" },
      ],
    });
    if (r.action !== "save") return;
    await saveAll();
    if (s.status.dirtyCount) return; // the save did not go through (conflict, error)
  }
  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  const who = (s.translator || "export").replace(/[^\p{L}\p{N}_-]+/gu, "_");
  try {
    const { path } = await api.pickSave(currentLang(), "zip", `MuMain-${s.open?.locale ?? ""}-${who}-${ymd}.zip`);
    if (!path) return;
    const res = await api.exportPackage(path, s.glossary?.path ?? null, s.translator);
    toast.success(tr("toast.packageExported", { file: res.path.split(/[\\/]/).pop() ?? res.path, n: res.translated, files: res.files }), {
      description: res.glossary ? tr("toast.packageWithGlossary") : undefined,
      duration: 10000,
    });
  } catch (e) {
    toast.error(errorText(e));
  }
}

// ---- Google Sheets ----

// One CSV per tab of the team sheet, in a ZIP (Key, English, <language>, Status, Note, BaseText;
// ItemType / ItemIndex for the item names). Each CSV goes into its tab with File -> Import ->
// Replace current sheet; a tab downloaded as CSV (or a ZIP of them) comes back through the import.
export async function exportSheets() {
  if (!(await commitEditor())) return;
  const s = store();
  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  try {
    const { path } = await api.pickSave(currentLang(), "zip", `MuMain_${(s.open?.locale ?? "").toUpperCase()}-sheets-${ymd}.zip`);
    if (!path) return;
    const res = await api.exportSheets(path);
    toast.success(tr("toast.sheetsExported", { file: res.path.split(/[\\/]/).pop() ?? res.path, tabs: res.tabs, n: res.rows }), {
      description: tr("toast.sheetsHint"),
      duration: 12000,
    });
  } catch (e) {
    toast.error(errorText(e));
  }
}

// ---- glossary ----

export async function openGlossaryFile(): Promise<boolean> {
  try {
    const { path } = await api.pick(currentLang(), "glossary");
    if (!path) return false;
    const g = await store().loadGlossary(path);
    toast.success(tr("toast.glossaryLoaded", { file: g.fileName, n: g.entries.length }));
    return true;
  } catch (e) {
    toast.error(errorText(e));
    return false;
  }
}

// Save to the loaded TSV, or ask for a path (new glossary / converting the legacy CSV).
export async function saveGlossary(entries: GlossaryEntry[], forceAsk = false): Promise<boolean> {
  const g = store().glossary;
  try {
    let path = g && g.format === "tsv" && !forceAsk ? g.path : null;
    if (!path) {
      const name = g ? g.fileName.replace(/\.[^.]+$/, "") : "Glossary";
      path = (await api.pickSave(currentLang(), "glossary", `${name}.tsv`)).path;
      if (!path) return false;
    }
    const saved = await store().saveGlossary(path, entries);
    toast.success(tr("toast.glossarySaved", { n: saved.entries.length, file: saved.fileName }));
    return true;
  } catch (e) {
    toast.error(errorText(e));
    return false;
  }
}

// ---- AI proposals ----

// Read the proposal files again. `quiet`: only say something when new ones came in (window focus).
export async function reloadProposals(quiet = false) {
  const s = store();
  if (s.view !== "workspace" || isFallback) return;
  try {
    const fresh = await s.loadProposals();
    const broken = s.proposals?.broken ?? [];
    if (fresh) toast.info(tr("toast.proposalsNew", { n: fresh }));
    else if (!quiet) toast(tr("toast.proposalsCount", { n: s.proposals?.items.length ?? 0 }));
    if (broken.length && !quiet) toast.warning(tr("toast.proposalsBroken", { files: broken.map((b) => b.name).join(", ") }), { duration: 10000 });
  } catch (e) {
    if (!quiet) toast.error(errorText(e));
  }
}

async function decide(decisions: ProposalDecision[]) {
  const res = await store().decideProposals(decisions);
  if (res.skipped) toast.warning(tr("toast.proposalsSkipped", { n: res.skipped }));
  return res;
}

// After deciding the proposal of a row: on to the next row of the list that has one.
function nextProposal(fromId: number) {
  const s = store();
  const list = s.visible;
  const from = visibleIndex(fromId);
  for (let i = from + 1; i < list.length; i++) if (s.proposalOf(list[i]!)) return select(list[i]!.id, true);
}

export async function acceptProposal(id: number) {
  const s = store();
  const row = s.rows[id];
  const p = row && s.proposalOf(row);
  if (!p || !(await ensureTranslator()) || !(await commitEditor())) return;
  try {
    await decide([{ file: p.file, index: p.index, action: "accept" }]);
    nextProposal(id);
  } catch (e) {
    toast.error(errorText(e));
  }
}

export function editProposal(id: number) {
  const s = store();
  const row = s.rows[id];
  const p = row && s.proposalOf(row);
  if (p) return startEdit(id, p);
}

export async function rejectProposal(id: number) {
  const s = store();
  const row = s.rows[id];
  const p = row && s.proposalOf(row);
  if (!p || !(await ensureTranslator()) || !(await commitEditor())) return;
  const r = await ask({
    title: tr("proposals.rejectDialog.title"),
    body: [tr("proposals.rejectDialog.body")],
    input: { label: tr("proposals.rejectDialog.label"), value: "", placeholder: tr("proposals.rejectDialog.placeholder") },
    actions: [
      { id: "cancel", label: tr("common.cancel") },
      { id: "reject", label: tr("proposals.reject"), kind: "primary" },
    ],
  });
  if (r.action !== "reject") return;
  try {
    await decide([{ file: p.file, index: p.index, action: "reject", reason: r.value }]);
    nextProposal(id);
  } catch (e) {
    toast.error(errorText(e));
  }
}

// A proposal that can be taken without looking: made from the translation as it is now, and no
// error / warning / glossary problem in the proposed text.
export function isCleanProposal(row: Row, p: ProposalRow): boolean {
  if (p.state !== "ok" && p.state !== "same") return false;
  if (p.issues.some(([code]) => SEVERITY[code] !== "info")) return false;
  return glossaryProblems({ ...row, value: p.value }, store().glossary?.entries ?? []).length === 0;
}

export const cleanProposals = () => {
  const s = store();
  return s.visible.flatMap((r) => {
    const p = s.proposalOf(r);
    return p && isCleanProposal(r, p) ? [p] : [];
  });
};

export async function acceptCleanProposals() {
  const list = cleanProposals();
  if (!list.length || !(await ensureTranslator()) || !(await commitEditor())) return;
  const r = await ask({
    title: tr("proposals.acceptAllDialog.title"),
    body: [tr("proposals.acceptAllDialog.body", { n: list.length })],
    actions: [
      { id: "cancel", label: tr("common.cancel") },
      { id: "accept", label: tr("proposals.acceptAllDialog.confirm", { n: list.length }), kind: "primary" },
    ],
  });
  if (r.action !== "accept") return;
  try {
    const res = await decide(list.map((p) => ({ file: p.file, index: p.index, action: "accept" as const })));
    toast.success(tr("toast.proposalsAccepted", { n: res.decided }), { duration: 8000 });
  } catch (e) {
    toast.error(errorText(e));
  }
}

// ---- keyboard ----

const inTextField = (el: Element | null) => el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;

export function onGlobalKeydown(e: KeyboardEvent) {
  const s = store();
  if (s.view !== "workspace" || anyDialogOpen() || e.isComposing) return;
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();
  if (mod && !e.altKey && key === "s") {
    e.preventDefault();
    saveAll();
  } else if (mod && !e.shiftKey && !e.altKey && key === "f") {
    e.preventDefault();
    searchFocus?.();
  } else if (mod && !inTextField(document.activeElement) && (key === "z" || key === "y")) {
    // Inside a text field, let the browser undo the typed text itself.
    e.preventDefault();
    undoRedo(key === "y" || e.shiftKey ? "redo" : "undo");
  }
}
