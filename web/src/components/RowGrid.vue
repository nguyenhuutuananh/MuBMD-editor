<script setup lang="ts">
import { Lock, Sparkles } from "@lucide/vue";
import { useVirtualizer } from "@tanstack/vue-virtual";
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import InlineEditor from "@/components/InlineEditor.vue";
import RichText from "@/components/RichText.vue";
import StatusDot from "@/components/StatusDot.vue";
import { canEdit, registerScroller, select, setStatus, startEdit, toggleKeep } from "@/composables/actions";
import { issueText } from "@/i18n";
import { type Row, glossaryProblems, itemId } from "@/lib/rows";
import { cn } from "@/lib/utils";
import { useDocStore } from "@/stores/doc";

const ROW = 32;
const HEAD = 32; // sticky header inside the scroll area, above the list
// Shared by the header and the rows so columns always line up. The md+ column list depends on whether
// a reference locale is shown, so it is passed through a CSS variable (Tailwind classes must be static).
const COLS = "grid grid-cols-[14px_minmax(120px,1fr)_minmax(120px,1fr)] md:[grid-template-columns:var(--cols)] items-center gap-2 px-3";
const STATUS_KEYS: Record<string, "untranslated" | "translated" | "reviewed"> = {
  Digit1: "untranslated",
  Digit2: "translated",
  Digit3: "reviewed",
};

const { t } = useI18n();
const store = useDocStore();
const scrollEl = ref<HTMLElement | null>(null);
const refLocale = computed(() => store.open?.reference ?? null);
const colsVar = computed(() => ({
  "--cols": `14px 64px minmax(160px,1fr) minmax(160px,1fr) ${refLocale.value ? "minmax(120px,0.7fr) " : ""}minmax(90px,0.5fr)`,
}));

const virtualizer = useVirtualizer(
  computed(() => ({
    count: store.visible.length,
    getScrollElement: () => scrollEl.value,
    estimateSize: () => ROW,
    overscan: 10,
    scrollMargin: HEAD,
    scrollPaddingStart: HEAD,
    getItemKey: (i: number) => store.visible[i]?.id ?? i,
  })),
);

// Rows are plain (non-reactive) objects; reading `rev` re-renders after edits.
const items = computed(() => {
  void store.rev;
  return virtualizer.value.getVirtualItems().map((v) => ({ v, row: store.visible[v.index]! }));
});

// "7:1" for an item (group : number), "#470" for Game texts converted from Text.bmd, else the group.
const idOf = (r: Row) =>
  r.source === "items" ? itemId(r) : r.legacyIds.length ? `#${r.legacyIds.join(",")}` : (store.groups[r.group]?.name ?? "");
const hashBreaks = (r: Row) => (r.en ?? "").includes("##");
const glossaryOf = (r: Row) => glossaryProblems(r, store.glossary?.entries ?? []);
const flagText = (r: Row) =>
  [...r.issues.map(issueText), ...glossaryOf(r).map((h) => t("grid.glossaryHint", { term: h.term })), r.record?.note ? `“${r.record.note}”` : ""]
    .filter(Boolean)
    .join("\n");
const flagClass = (r: Row) => (r.worst === "error" ? "text-destructive" : r.worst === "warning" ? "text-warn" : "text-muted-foreground");
const flagLabel = (r: Row) =>
  [
    r.issues.length ? `${t(`severity.${r.worst}`)}${r.issues.length > 1 ? ` +${r.issues.length - 1}` : ""}` : "",
    glossaryOf(r).length ? t("grid.glossary") : "",
    r.record?.note ? `“${r.record.note}”` : "",
  ]
    .filter(Boolean)
    .join(" · ");

function idAt(target: EventTarget | null): number | null {
  const el = (target as HTMLElement).closest<HTMLElement>("[data-row]");
  return el?.dataset.row ? Number(el.dataset.row) : null;
}

function onClick(e: MouseEvent) {
  const id = idAt(e.target);
  if (id !== null) select(id);
  scrollEl.value?.focus();
}

function onDblclick(e: MouseEvent) {
  const id = idAt(e.target);
  if (id !== null) startEdit(id);
}

function onKeydown(e: KeyboardEvent) {
  if (e.target !== scrollEl.value || !store.visible.length) return;
  const sel = store.selectedId;
  if ((e.key === "Enter" || e.key === "F2") && sel !== null) {
    e.preventDefault();
    startEdit(sel);
    return;
  }
  // Alt+1/2/3: set the status (e.code, because Alt changes e.key on macOS).
  if (e.altKey && !e.ctrlKey && !e.metaKey && STATUS_KEYS[e.code] && sel !== null) {
    e.preventDefault();
    const r = store.rows[sel];
    if (r) setStatus([r], STATUS_KEYS[e.code]!);
    return;
  }
  // Alt+K: keep English / translate again.
  if (e.altKey && !e.ctrlKey && !e.metaKey && e.code === "KeyK" && sel !== null) {
    e.preventDefault();
    toggleKeep(sel);
    return;
  }
  const page = Math.max(1, Math.floor(((scrollEl.value?.clientHeight ?? 0) - HEAD) / ROW) - 1);
  const step: Record<string, number> = { ArrowDown: 1, ArrowUp: -1, PageDown: page, PageUp: -page };
  const cur = sel === null ? -1 : store.visible.findIndex((r) => r.id === sel);
  let next: number | null = null;
  if (e.key in step) next = cur < 0 ? 0 : cur + step[e.key]!;
  else if (e.key === "Home") next = 0;
  else if (e.key === "End") next = store.visible.length - 1;
  if (next === null) return;
  e.preventDefault();
  next = Math.max(0, Math.min(store.visible.length - 1, next));
  select(store.visible[next]!.id, true);
}

onMounted(() => registerScroller((i) => virtualizer.value.scrollToIndex(i, { align: "auto" })));
onBeforeUnmount(() => registerScroller(null));
</script>

<template>
  <div class="relative flex min-h-0 flex-1 flex-col" role="grid" :aria-label="t('grid.label')" :aria-rowcount="store.visible.length">
    <div
      id="grid-body"
      ref="scrollEl"
      :style="colsVar"
      class="focus-visible:ring-ring/50 relative min-h-0 flex-1 overflow-auto outline-none focus-visible:ring-2 focus-visible:ring-inset"
      tabindex="0"
      data-testid="grid"
      @click="onClick"
      @dblclick="onDblclick"
      @keydown="onKeydown"
    >
      <div :class="cn(COLS, 'bg-muted text-muted-foreground sticky top-0 z-10 h-8 border-b text-xs font-semibold')" role="row">
        <span />
        <span class="hidden md:block">{{ t("grid.id") }}</span>
        <span>{{ t("grid.en") }}</span>
        <span>{{ t("grid.translation") }} ({{ store.open?.locale }})</span>
        <span v-if="refLocale" class="hidden truncate md:block">{{ t("grid.reference", { locale: refLocale }) }}</span>
        <span class="hidden md:block">{{ t("grid.flags") }}</span>
      </div>
      <div class="relative" :style="{ height: `${virtualizer.getTotalSize()}px` }">
        <div
          v-for="{ v, row } in items"
          :key="row.id"
          :data-row="row.id"
          role="row"
          :aria-selected="row.id === store.selectedId"
          :class="
            cn(
              COLS,
              'bg-card hover:bg-muted absolute inset-x-0 top-0 h-8 border-b',
              row.id === store.selectedId && 'bg-row-selected hover:bg-row-selected',
              row.worst === 'error' && 'shadow-[inset_3px_0_0_var(--destructive)]',
              row.dirty && 'shadow-[inset_3px_0_0_var(--brand)]',
            )
          "
          :style="{ transform: `translateY(${v.start - HEAD}px)` }"
        >
          <StatusDot :status="row.status" />
          <span class="text-muted-foreground hidden truncate text-xs tabular-nums md:block" :title="idOf(row)">{{ idOf(row) }}</span>
          <RichText v-if="row.en !== null" :text="row.en" :hash-breaks="hashBreaks(row)" class="text-muted-foreground" />
          <span v-else class="text-muted-foreground truncate italic">{{ t("grid.extra") }}</span>
          <InlineEditor v-if="store.editor?.id === row.id" :row="row" />
          <span v-else-if="row.value !== null" class="flex min-w-0 items-center gap-1">
            <Sparkles v-if="store.proposalOf(row)" class="text-brand size-3 shrink-0" :title="t('grid.proposal')" data-testid="row-proposal" />
            <Lock v-if="row.keep" class="text-muted-foreground size-3 shrink-0" :title="t('state.kept')" />
            <RichText
              :text="row.value"
              :hash-breaks="hashBreaks(row)"
              :class="row.dirty && 'font-semibold'"
              :title="row.dirty ? t('grid.savedTitle', { text: row.saved ?? t('grid.missing') }) : undefined"
            />
          </span>
          <span v-else class="flex min-w-0 items-center gap-1">
            <Sparkles v-if="store.proposalOf(row)" class="text-brand size-3 shrink-0" :title="t('grid.proposal')" data-testid="row-proposal" />
            <span class="text-muted-foreground truncate italic" :class="!canEdit(row) && 'line-through'">{{ t("grid.missing") }}</span>
          </span>
          <span v-if="refLocale" class="text-muted-foreground hidden min-w-0 md:flex">
            <RichText v-if="row.reference !== null" :text="row.reference" :hash-breaks="hashBreaks(row)" />
          </span>
          <span class="hidden truncate text-xs md:block" :class="flagClass(row)" :title="flagText(row)">{{ flagLabel(row) }}</span>
        </div>
      </div>
    </div>
    <div v-if="!store.visible.length" class="text-muted-foreground absolute inset-x-0 top-16 text-center">{{ t("grid.noMatch") }}</div>
  </div>
</template>
