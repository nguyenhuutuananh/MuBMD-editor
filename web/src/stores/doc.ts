// doc.ts - State of the open file + API calls. Flows with dialogs (confirmations, conflicts...) live in composables/actions.ts.
//
// The 8192 rows live in a shallowRef (no deep reactivity). An edit patches the row in place and
// bumps `rev`, so components reading `rev` re-render.

import { defineStore } from "pinia";
import { reactive, ref, shallowRef, watch } from "vue";
import type { DocStatus, DraftInfo, FileInfo, MutationResponse, SaveRequest } from "../../../src/shared/api";
import { api } from "@/lib/api";
import { type Filter, type Row, applyFilter, patchRow, toRows } from "@/lib/search";
import { KEYS, load, save } from "@/lib/storage";

export interface EditorState {
  slot: number;
  value: string;
  initial: string;
}

// Edits are sent to the server one at a time, in the order the user made them.
let chain: Promise<unknown> = Promise.resolve();
export function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.catch(() => undefined);
  return run;
}

export const useDocStore = defineStore("doc", () => {
  const view = ref<"welcome" | "workspace">("welcome");
  const file = ref<FileInfo | null>(null);
  const rows = shallowRef<Row[]>([]);
  const visible = shallowRef<Row[]>([]);
  const rev = ref(0);
  const status = ref<DocStatus>({ dirtyCount: 0, canUndo: false, canRedo: false });
  const selectedSlot = ref<number | null>(null);
  const editor = ref<EditorState | null>(null);
  const translator = ref(load<string>(KEYS.translator, ""));
  const recent = ref(load<string[]>(KEYS.recent, []));

  const saved = load<Partial<Filter>>(KEYS.filter, {});
  const filter = reactive<Filter>({
    group: typeof saved.group === "number" ? saved.group : null,
    scope: saved.scope ?? "named",
    problem: saved.problem ?? "any",
    query: "",
  });

  // Re-filter when the filter changes. After an edit we do NOT re-filter (only bump rev) so the edited row does not jump away.
  function refilter() {
    editor.value = null;
    visible.value = applyFilter(rows.value, filter);
  }
  watch(
    () => [filter.group, filter.scope, filter.problem] as const,
    ([group, scope, problem]) => {
      save(KEYS.filter, { group, scope, problem });
      refilter();
    },
  );
  watch(() => filter.query, refilter);

  function setTranslator(name: string) {
    translator.value = name;
    save(KEYS.translator, name);
  }

  function rememberRecent(path: string) {
    recent.value = [path, ...recent.value.filter((p) => p !== path)].slice(0, 6);
    save(KEYS.recent, recent.value);
  }

  // Returns the pending draft (if any) so the caller can ask the user.
  async function loadItems(): Promise<DraftInfo | null> {
    editor.value = null;
    const res = await api.items();
    file.value = res.file;
    rows.value = toRows(res.items, res.edits);
    status.value = res.status;
    if (selectedSlot.value !== null && !rows.value[selectedSlot.value]) selectedSlot.value = null;
    view.value = "workspace";
    refilter();
    rev.value++;
    return res.draft;
  }

  async function open(path: string, discard = false): Promise<DraftInfo | null> {
    await api.open(path, discard);
    rememberRecent(path);
    return loadItems();
  }

  function applyMutation(res: MutationResponse) {
    for (const { item, edit } of res.changed) {
      const row = rows.value[item[0]];
      if (row) patchRow(row, item, edit);
    }
    status.value = res.status;
    rev.value++;
  }

  const mutate = async <T extends MutationResponse>(fn: () => Promise<T>): Promise<T> => {
    const res = await serial(fn);
    applyMutation(res);
    return res;
  };

  return {
    view,
    file,
    rows,
    visible,
    rev,
    status,
    selectedSlot,
    editor,
    translator,
    recent,
    filter,
    refilter,
    setTranslator,
    loadItems,
    open,
    applyMutation,
    edit: (slot: number, name: string) => mutate(() => api.edit(slot, name, translator.value)),
    revert: (slot: number) => mutate(() => api.revert(slot, translator.value)),
    undo: () => mutate(() => api.undo()),
    redo: () => mutate(() => api.redo()),
    restoreDraft: () => mutate(() => api.restoreDraft()),
    discardDraft: () => api.discardDraft(),
    save: (opts: SaveRequest = {}) => serial(() => api.save(opts)),
  };
});
