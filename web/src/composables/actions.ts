// actions.ts - User flows: open / edit / save, including dialogs and toasts.

import { ref, shallowRef } from "vue";
import { toast } from "vue-sonner";
import { checkName } from "../../../src/core/nameCodec";
import type { DraftInfo, GlossaryEntry, ImportPreview, SaveRequest, Status } from "../../../src/shared/api";
import { currentLang, errorText, fmtTime, issueText, tr } from "@/i18n";
import { ApiError, api } from "@/lib/api";
import { ask, isDialogOpen } from "@/lib/dialogs";
import { useDocStore } from "@/stores/doc";

export const welcomeError = ref<string | null>(null);
export const exportOpen = ref(false);
export const importPreview = shallowRef<ImportPreview | null>(null);
export const glossaryOpen = ref(false);

export const anyDialogOpen = () =>
  isDialogOpen.value || exportOpen.value || importPreview.value !== null || glossaryOpen.value;

// ItemGrid registers a function that scrolls to a row (by index in the filtered list).
let scroller: ((index: number) => void) | null = null;
export function registerScroller(fn: ((index: number) => void) | null) {
  scroller = fn;
}

const store = () => useDocStore();
const visibleIndex = (slot: number) => store().visible.findIndex((r) => r.slot === slot);

export function select(slot: number | null, scroll = false) {
  const s = store();
  s.selectedSlot = slot;
  if (scroll && slot !== null) {
    const i = visibleIndex(slot);
    if (i >= 0) scroller?.(i);
  }
}

// ---- open ----

export function showWelcome() {
  store().editor = null;
  store().view = "welcome";
}

export function backToFile() {
  welcomeError.value = null;
  store().view = "workspace";
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

// After a file is opened: re-load its remembered reference file, report a rebase, offer the draft.
async function afterOpen(draft: DraftInfo | null) {
  const s = store();
  const refPath = s.file ? s.referenceFor(s.file.path) : null;
  if (refPath) {
    try {
      await s.loadReference(refPath);
    } catch (e) {
      toast.error(errorText(e));
      await s.loadReference(null).catch(() => undefined);
    }
  }
  if (s.rebased) toast.info(tr("toast.rebased"), { duration: 10000 });
  if (draft) await offerDraft(draft);
}

export async function openPath(path: string, discard = false): Promise<void> {
  welcomeError.value = null;
  try {
    await afterOpen(await store().open(path, discard));
  } catch (e) {
    if (e instanceof ApiError && e.code === "dirty") {
      if (await confirmDiscard()) return openPath(path, true);
      return;
    }
    showWelcome();
    welcomeError.value = errorText(e);
  }
}

export async function pickAndOpen() {
  welcomeError.value = null;
  try {
    const { path } = await api.pick(currentLang());
    if (path) await openPath(path);
  } catch (e) {
    welcomeError.value = errorText(e);
  }
}

export async function reload() {
  const f = store().file;
  if (f) await openPath(f.path);
}

// On startup: if the server already has a file open (path on the command line), go straight to it.
export async function start() {
  // The team glossary is remembered per browser (one file for every Item.bmd).
  const g = store().rememberedGlossary();
  if (g) store().loadGlossary(g).catch((e) => toast.error(errorText(e)));
  try {
    const state = await api.state();
    if (state.file) await afterOpen(await store().loadItems(false));
  } catch (e) {
    welcomeError.value = errorText(e);
  }
}

async function offerDraft(d: DraftInfo) {
  const body = [tr("draftDialog.body", { n: d.count, time: fmtTime(d.savedAt) })];
  if (d.translators.length) body.push(tr("draftDialog.who", { names: d.translators.join(", ") }));
  if (!d.baseMatches) body.push(tr("draftDialog.baseChanged"));
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
    input: {
      label: tr("translatorDialog.label"),
      value: store().translator,
      placeholder: tr("translatorDialog.placeholder"),
      required: true,
    },
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

export async function startEdit(slot: number) {
  if (!(await ensureTranslator())) return;
  const s = store();
  const row = s.rows[slot];
  if (!row || visibleIndex(slot) < 0) return;
  select(slot, true);
  // Non-UTF-8 names display garbled (U+FFFD), so do not prefill them - avoids writing garbage back.
  const initial = row.encoding === "unknown" ? "" : row.text;
  s.editor = { slot, value: initial, initial };
}

export function cancelEdit() {
  store().editor = null;
}

// Returns true if the editor is closed (saved, or nothing changed).
export async function commitEditor(opts: { quiet?: boolean } = {}): Promise<boolean> {
  const s = store();
  const ed = s.editor;
  if (!ed) return true;
  const row = s.rows[ed.slot];
  if (!row) return true;
  const c = checkName(ed.value);
  const unchanged = c.normalized === ed.initial || (row.encoding === "unknown" && ed.value === "");
  if (unchanged) {
    if (s.editor === ed) s.editor = null;
    return true;
  }
  if (!c.ok) {
    if (!opts.quiet) toast.error(issueText(c.issues.find((i) => i.severity === "error")!));
    return false;
  }
  try {
    const value = ed.value;
    await s.edit(ed.slot, value);
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
  const from = visibleIndex(ed.slot);
  if (!(await commitEditor())) return;
  const next = s.visible[from + step];
  if (next) await startEdit(next.slot);
}

export async function revert(slot: number) {
  cancelEdit();
  try {
    await store().revert(slot);
  } catch (e) {
    toast.error(errorText(e));
  }
}

export async function undoRedo(which: "undo" | "redo") {
  if (!(await commitEditor())) return;
  try {
    const res = await (which === "undo" ? store().undo() : store().redo());
    const first = res.changed[0]?.item[0];
    if (first !== undefined && visibleIndex(first) >= 0) select(first, true);
  } catch (e) {
    toast.error(errorText(e));
  }
}

// ---- status / note ----

export async function setStatus(slots: number[], status: Status) {
  if (!slots.length || !(await ensureTranslator())) return;
  if (!(await commitEditor())) return;
  try {
    const res = await store().setStatus(slots, status);
    if (slots.length > 1) toast.success(tr("toast.statusSet", { n: res.changed.length, status: tr(`status.${status}`) }));
  } catch (e) {
    toast.error(errorText(e));
  }
}

export async function setNote(slot: number, note: string) {
  if (!(await ensureTranslator())) return;
  try {
    await store().setNote(slot, note);
  } catch (e) {
    toast.error(errorText(e));
  }
}

// ---- reference ----

export async function chooseReference() {
  try {
    const { path } = await api.pick(currentLang(), "reference");
    if (!path) return;
    const info = await store().loadReference(path);
    if (info) toast.success(tr("toast.referenceLoaded", { file: info.fileName, n: info.entries.length }));
  } catch (e) {
    toast.error(errorText(e));
  }
}

export async function clearReference() {
  try {
    await store().loadReference(null);
  } catch (e) {
    toast.error(errorText(e));
  }
}

// ---- TSV export / import ----

// Slots "I changed": last touched by me and different from the merge base.
export function mySlots(): number[] {
  const s = store();
  const me = s.translator;
  if (!me) return [];
  return s.rows.filter((r) => r.record.translator === me && r.record.origin !== undefined && r.record.origin !== r.text).map((r) => r.slot);
}

export async function exportTsv(slots: number[]) {
  if (!(await commitEditor())) return;
  const s = store();
  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  const who = (s.translator || "export").replace(/[^\p{L}\p{N}_-]+/gu, "_");
  const base = (s.file?.fileName ?? "Item.bmd").replace(/\.bmd$/i, "");
  try {
    const { path } = await api.pickSave(currentLang(), "tsv", `${base}-${who}-${ymd}.tsv`);
    if (!path) return;
    const res = await api.exportTsv(path, slots);
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

export async function applyImport(take: number[]) {
  const p = importPreview.value;
  if (!p || !(await ensureTranslator())) return;
  try {
    const res = await store().importApply(p.path, p.token, take);
    importPreview.value = null;
    toast.success(tr("toast.imported", { n: res.changed.length }), { duration: 8000 });
    store().filter.problem = "edited"; // show what came in, for review
  } catch (e) {
    toast.error(errorText(e));
    if (e instanceof ApiError && e.code === "import-changed") importPreview.value = null;
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

// ---- compare with another Item.bmd (reuses the import preview) ----

export async function compareWith() {
  if (!(await commitEditor())) return;
  try {
    const { path } = await api.pick(currentLang(), "compare");
    if (!path) return;
    importPreview.value = await api.importPreview(path);
  } catch (e) {
    toast.error(errorText(e));
  }
}

// ---- save ----

export async function saveFile(opts: SaveRequest = {}) {
  if (!(await commitEditor())) return;
  try {
    const res = await store().save(opts);
    await store().loadItems();
    if (!res.savedCount) {
      toast(tr("toast.nothingToSave"));
      return;
    }
    toast.success(tr("toast.saved", { n: res.savedCount, file: res.file.fileName }), {
      description: res.backupPath ? tr("toast.backup", { path: res.backupPath }) : undefined,
      duration: 8000,
    });
  } catch (e) {
    if (e instanceof ApiError && e.code === "conflict") return resolveConflict();
    toast.error(tr("toast.saveFailed", { reason: errorText(e) }), { duration: 10000 });
  }
}

async function resolveConflict() {
  const r = await ask({
    title: tr("conflictDialog.title"),
    body: [tr("errors.conflict"), tr("conflictDialog.body")],
    actions: [
      { id: "cancel", label: tr("common.cancel") },
      { id: "force", label: tr("conflictDialog.force"), kind: "danger" },
      { id: "save-as", label: tr("conflictDialog.saveAs"), kind: "primary" },
    ],
  });
  if (r.action === "force") await saveFile({ force: true });
  else if (r.action === "save-as") await saveAs();
}

export async function saveAs() {
  if (!(await commitEditor())) return;
  try {
    const { path } = await api.pickSave(currentLang());
    if (path) await saveFile({ path });
  } catch (e) {
    toast.error(errorText(e));
  }
}

// ---- global shortcuts ----

const inTextField = (el: Element | null) => el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;

export function onGlobalKeydown(e: KeyboardEvent, focusSearch: () => void) {
  if (store().view !== "workspace" || anyDialogOpen()) return;
  if (!(e.ctrlKey || e.metaKey) || e.isComposing) return;
  const key = e.key.toLowerCase();
  if (key === "s") {
    e.preventDefault();
    if (e.shiftKey) saveAs();
    else saveFile();
  } else if (key === "f") {
    e.preventDefault();
    focusSearch();
  } else if (!inTextField(document.activeElement) && (key === "z" || key === "y")) {
    // Inside a text field, let the browser undo the typed text itself.
    e.preventDefault();
    undoRedo(key === "y" || e.shiftKey ? "redo" : "undo");
  }
}
