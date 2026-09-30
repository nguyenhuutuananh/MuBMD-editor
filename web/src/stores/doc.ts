// doc.ts - State of the open folder + API calls. Flows with dialogs / errors live in composables/actions.ts.
//
// The rows live in a shallowRef (no deep reactivity): ~3700 plain objects. An edit replaces the
// changed rows in place and bumps `rev`; the filtered list is NOT recomputed then, so the edited
// row does not jump away from under the cursor.

import { defineStore } from "pinia";
import { computed, reactive, ref, shallowRef, watch } from "vue";
import { SEVERITY } from "../../../src/core/validate";
import type {
  DocStatus,
  DraftInfo,
  WorkspaceListing,
  GlossaryEntry,
  GlossaryInfo,
  GroupInfo,
  Issue,
  KeyRef,
  MutationResponse,
  OpenInfo,
  RegistrationInfo,
  SaveRequest,
  Status,
} from "../../../src/shared/api";
import { api } from "@/lib/api";
import { type Filter, type Row, applyFilter, toRow, toRows } from "@/lib/rows";
import { KEYS, load, save } from "@/lib/storage";

export interface RecentEntry {
  path: string;
  locale: string;
  reference: string | null;
}

export interface EditorState {
  id: number;
  value: string;
  initial: string; // "" for a missing translation
}

// Changes are sent to the server one at a time, in the order the user made them.
let chain: Promise<unknown> = Promise.resolve();
export function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.catch(() => undefined);
  return run;
}

const rowKey = (group: number, key: string) => `${group}\u0000${key}`;

export const useDocStore = defineStore("doc", () => {
  const view = ref<"welcome" | "workspace">("welcome");
  const listing = shallowRef<WorkspaceListing | null>(null); // welcome step 2: choose the locale
  const open = shallowRef<OpenInfo | null>(null);
  const groups = shallowRef<GroupInfo[]>([]);
  const rows = shallowRef<Row[]>([]);
  const visible = shallowRef<Row[]>([]);
  const rev = ref(0);
  const looseIssues = shallowRef<Issue[]>([]);
  const status = ref<DocStatus>({ dirtyCount: 0, canUndo: false, canRedo: false });
  const selectedId = ref<number | null>(null);
  const editor = ref<EditorState | null>(null);
  const translator = ref(load<string>(KEYS.translator, ""));
  const recent = ref(load<RecentEntry[]>(KEYS.recent, []));
  const glossary = shallowRef<GlossaryInfo | null>(null);
  const registration = shallowRef<RegistrationInfo | null>(null);
  const glossaryEntries = () => glossary.value?.entries ?? [];
  let index = new Map<string, number>(); // group + key -> row id

  const saved = load<Partial<Filter>>(KEYS.filter, {});
  const filter = reactive<Filter>({
    source: saved.source === "resx" || saved.source === "items" ? saved.source : null,
    group: typeof saved.group === "number" ? saved.group : null,
    state: saved.state ?? "any",
    status: saved.status ?? "any",
    severity: saved.severity ?? "any",
    query: "",
  });

  const selected = computed(() => {
    void rev.value;
    return selectedId.value === null ? null : (rows.value[selectedId.value] ?? null);
  });
  // Errors in the en files: the MuMain build stops (whatever the translation says).
  const buildErrors = computed(
    () =>
      rows.value.filter((r) => r.issues.some(([code, locale]) => locale === "en" && SEVERITY[code] === "error")).length +
      looseIssues.value.filter((i) => i.severity === "error").length,
  );

  function refilter() {
    editor.value = null;
    visible.value = applyFilter(rows.value, filter, glossaryEntries());
  }
  watch(
    () => [filter.source, filter.group, filter.state, filter.status, filter.severity] as const,
    ([source, group, state, status, severity]) => {
      save(KEYS.filter, { source, group, state, status, severity });
      refilter();
    },
  );
  watch(() => filter.query, refilter);
  watch(glossary, () => {
    if (filter.severity === "glossary") refilter();
    rev.value++;
  });

  async function loadGlossary(path: string): Promise<GlossaryInfo> {
    glossary.value = await api.glossaryLoad(path);
    save(KEYS.glossary, glossary.value.path);
    return glossary.value;
  }

  async function saveGlossary(path: string, entries: GlossaryEntry[]): Promise<GlossaryInfo> {
    glossary.value = await api.glossarySave(path, entries);
    save(KEYS.glossary, glossary.value.path);
    return glossary.value;
  }

  const rememberedGlossary = () => load<string | null>(KEYS.glossary, null);

  function rememberRecent(entry: RecentEntry) {
    recent.value = [entry, ...recent.value.filter((r) => r.path !== entry.path)].slice(0, 6);
    save(KEYS.recent, recent.value);
  }

  function setTranslator(name: string) {
    translator.value = name;
    save(KEYS.translator, name);
  }

  // Returns the draft of an earlier session, if any, so the caller can offer it.
  async function loadRows(): Promise<DraftInfo | null> {
    const res = await api.rows();
    open.value = res.open;
    groups.value = res.groups;
    rows.value = toRows(res.rows, res.groups);
    index = new Map(rows.value.map((r) => [rowKey(r.group, r.key), r.id]));
    looseIssues.value = res.issues;
    status.value = res.status;
    if (filter.group !== null && filter.group >= res.groups.length) filter.group = null;
    if (filter.source !== null && !res.groups.some((g) => g.source === filter.source)) filter.source = null;
    if (selectedId.value !== null && !rows.value[selectedId.value]) selectedId.value = null;
    view.value = "workspace";
    refilter();
    rev.value++;
    // Not essential: a failure only hides the "not selectable in the game" notice.
    api.registration().then(
      (r) => (registration.value = r),
      () => (registration.value = null),
    );
    return res.draft;
  }

  function applyMutation(res: MutationResponse) {
    const list = rows.value;
    for (const t of res.changed) {
      const k = rowKey(t[0], t[1]);
      const at = index.get(k);
      if (at !== undefined) list[at] = toRow(t, at, res.groups);
      else {
        index.set(k, list.length);
        list.push(toRow(t, list.length, res.groups));
      }
    }
    // The filtered list holds the old objects: swap in the new ones, same order.
    visible.value = visible.value.map((r) => list[r.id] ?? r);
    groups.value = res.groups;
    status.value = res.status;
    rev.value++;
  }

  const mutate = async <T extends MutationResponse>(fn: () => Promise<T>): Promise<T> => {
    const res = await serial(fn);
    applyMutation(res);
    return res;
  };

  async function scan(path: string) {
    listing.value = await api.scan(path);
    return listing.value;
  }

  async function openFolder(path: string, locale: string, reference: string | null, discard = false, create = false) {
    const { open: info } = await serial(() => api.open(path, locale, reference, discard, create));
    if (info) rememberRecent({ path: info.folder.path, locale: info.locale, reference: info.reference });
    listing.value = null;
    selectedId.value = null;
    return loadRows();
  }

  async function setReference(locale: string | null) {
    const { open: info } = await serial(() => api.reference(locale));
    if (info) rememberRecent({ path: info.folder.path, locale: info.locale, reference: info.reference });
    await loadRows();
  }

  const groupName = (r: Row) => groups.value[r.group]?.name ?? "";
  // The sources of the open workspace, in sidebar order.
  const sources = computed(() => [...new Set(groups.value.map((g) => g.source))]);
  const refOf = (r: Row): KeyRef => [groupName(r), r.key];

  return {
    view,
    listing,
    open,
    groups,
    rows,
    visible,
    rev,
    looseIssues,
    status,
    selectedId,
    selected,
    editor,
    translator,
    recent,
    filter,
    buildErrors,
    sources,
    glossary,
    registration,
    loadGlossary,
    saveGlossary,
    rememberedGlossary,
    refOf,
    refilter,
    loadRows,
    scan,
    openFolder,
    setReference,
    setTranslator,
    edit: (r: Row, value: string | null) => mutate(() => api.edit(groupName(r), r.key, value, translator.value)),
    keep: (r: Row, keep: boolean) => mutate(() => api.keep(groupName(r), r.key, keep, translator.value)),
    revert: (r: Row) => mutate(() => api.revert(groupName(r), r.key)),
    setStatus: (list: Row[], s: Status) => mutate(() => api.status(list.map(refOf), s, translator.value)),
    setNote: (r: Row, note: string) => mutate(() => api.note(groupName(r), r.key, note, translator.value)),
    importApply: (path: string, token: string, take: KeyRef[]) => mutate(() => api.importApply(path, token, take, translator.value)),
    undo: () => mutate(() => api.undo()),
    redo: () => mutate(() => api.redo()),
    restoreDraft: () => mutate(() => api.restoreDraft()),
    discardDraft: () => serial(() => api.discardDraft()),
    save: (opts: SaveRequest = {}) => serial(() => api.save(opts)),
    rebase: () => serial(() => api.rebase()),
  };
});
