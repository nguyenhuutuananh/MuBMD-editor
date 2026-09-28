<script setup lang="ts">
import { useVirtualizer } from "@tanstack/vue-virtual";
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import BytesMeter from "@/components/BytesMeter.vue";
import InlineEditor from "@/components/InlineEditor.vue";
import { registerScroller, select, startEdit } from "@/composables/actions";
import type { Row } from "@/lib/search";
import { cn } from "@/lib/utils";
import { useDocStore } from "@/stores/doc";

const ROW = 32;
const HEAD = 32; // sticky header inside the scroll area, above the list
// Shared by the header and the rows so columns always line up.
const COLS =
  "grid grid-cols-[36px_44px_minmax(120px,1fr)_64px] md:grid-cols-[52px_60px_minmax(160px,1fr)_92px_minmax(120px,0.8fr)] items-center gap-2 px-3";

const { t } = useI18n();
const store = useDocStore();
const scrollEl = ref<HTMLElement | null>(null);

const virtualizer = useVirtualizer(
  computed(() => ({
    count: store.visible.length,
    getScrollElement: () => scrollEl.value,
    estimateSize: () => ROW,
    overscan: 10,
    scrollMargin: HEAD,
    scrollPaddingStart: HEAD,
    getItemKey: (i: number) => store.visible[i]?.slot ?? i,
  })),
);

// Rows are plain (non-reactive) objects; reading `rev` re-renders after edits.
const items = computed(() => {
  void store.rev;
  return virtualizer.value.getVirtualItems().map((v) => ({ v, row: store.visible[v.index]! }));
});

function flags(r: Row): string[] {
  return [
    r.edit ? t("grid.edited") : "",
    r.encoding === "unknown" ? t("grid.nonUtf8") : "",
    ...r.issues.map((c) => t(`issues.${c}`)),
  ].filter(Boolean);
}

function slotAt(target: EventTarget | null): number | null {
  const el = (target as HTMLElement).closest<HTMLElement>("[data-slot]");
  return el?.dataset.slot ? Number(el.dataset.slot) : null;
}

function onClick(e: MouseEvent) {
  const slot = slotAt(e.target);
  if (slot !== null) select(slot);
  scrollEl.value?.focus();
}

function onDblclick(e: MouseEvent) {
  const slot = slotAt(e.target);
  if (slot !== null) startEdit(slot);
}

function onKeydown(e: KeyboardEvent) {
  if (e.target !== scrollEl.value || !store.visible.length) return;
  const sel = store.selectedSlot;
  if ((e.key === "Enter" || e.key === "F2") && sel !== null) {
    e.preventDefault();
    startEdit(sel);
    return;
  }
  const page = Math.max(1, Math.floor(((scrollEl.value?.clientHeight ?? 0) - HEAD) / ROW) - 1);
  const step: Record<string, number> = { ArrowDown: 1, ArrowUp: -1, PageDown: page, PageUp: -page };
  const cur = sel === null ? -1 : store.visible.findIndex((r) => r.slot === sel);
  let next: number | null = null;
  if (e.key in step) next = cur < 0 ? 0 : cur + step[e.key]!;
  else if (e.key === "Home") next = 0;
  else if (e.key === "End") next = store.visible.length - 1;
  if (next === null) return;
  e.preventDefault();
  next = Math.max(0, Math.min(store.visible.length - 1, next));
  select(store.visible[next]!.slot, true);
}

onMounted(() => registerScroller((i) => virtualizer.value.scrollToIndex(i, { align: "auto" })));
onBeforeUnmount(() => registerScroller(null));
</script>

<template>
  <div class="relative flex min-h-0 flex-1 flex-col" role="grid" :aria-label="t('grid.label')" :aria-rowcount="store.visible.length">
    <div
      id="grid-body"
      ref="scrollEl"
      class="focus-visible:ring-ring/50 relative min-h-0 flex-1 overflow-auto outline-none focus-visible:ring-2 focus-visible:ring-inset"
      tabindex="0"
      data-testid="grid"
      @click="onClick"
      @dblclick="onDblclick"
      @keydown="onKeydown"
    >
      <div :class="cn(COLS, 'bg-muted text-muted-foreground sticky top-0 z-10 h-8 border-b text-xs font-semibold')" role="row">
        <span class="text-right">{{ t("grid.type") }}</span>
        <span class="text-right">{{ t("grid.index") }}</span>
        <span>{{ t("grid.name") }}</span>
        <span>{{ t("grid.bytes") }}</span>
        <span class="hidden md:block">{{ t("grid.notes") }}</span>
      </div>
      <div class="relative" :style="{ height: `${virtualizer.getTotalSize()}px` }">
        <div
          v-for="{ v, row } in items"
          :key="row.slot"
          :data-slot="row.slot"
          role="row"
          :aria-selected="row.slot === store.selectedSlot"
          :class="
            cn(
              COLS,
              'bg-card hover:bg-muted absolute inset-x-0 top-0 h-8 border-b tabular-nums',
              row.slot === store.selectedSlot && 'bg-row-selected hover:bg-row-selected',
              row.edit && 'shadow-[inset_3px_0_0_var(--brand)]',
            )
          "
          :style="{ transform: `translateY(${v.start - HEAD}px)` }"
        >
          <span class="text-muted-foreground truncate text-right">{{ row.itemType }}</span>
          <span class="text-muted-foreground truncate text-right">{{ row.itemIndex }}</span>
          <InlineEditor v-if="store.editor?.slot === row.slot" :row="row" />
          <template v-else>
            <span
              :class="cn('truncate', row.encoding === 'empty' && 'text-muted-foreground italic', row.edit && 'font-semibold')"
              :title="row.edit ? t('grid.originalTitle', { name: row.edit.originalText || t('grid.empty') }) : row.text"
            >
              {{ row.encoding === "empty" ? t("grid.empty") : row.text }}
            </span>
            <BytesMeter :bytes="row.byteLength" />
          </template>
          <span
            class="hidden truncate text-xs md:block"
            :class="row.edit ? 'text-brand' : 'text-warn'"
            :title="flags(row).join('\n')"
          >
            {{ flags(row).join(" · ") }}
          </span>
        </div>
      </div>
    </div>
    <div v-if="!store.visible.length" class="text-muted-foreground absolute inset-x-0 top-16 text-center">{{ t("grid.noMatch") }}</div>
  </div>
</template>
