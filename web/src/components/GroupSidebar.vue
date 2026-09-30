<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { MAX_ITEM_TYPE } from "../../../src/core/format";
import { groupCounts } from "@/lib/search";
import { cn } from "@/lib/utils";
import { useDocStore } from "@/stores/doc";

const { t, n } = useI18n();
const store = useDocStore();

const groups = computed(() => {
  void store.rev; // re-render after edits
  const counts = groupCounts(store.rows, MAX_ITEM_TYPE);
  const edited = new Array<number>(MAX_ITEM_TYPE).fill(0);
  for (const r of store.rows) if (r.dirty) edited[r.itemType]!++;
  return counts.map((c, g) => ({ group: g, items: c.items, named: c.named, edited: edited[g]! }));
});
const total = computed(() =>
  groups.value.reduce((s, g) => ({ items: s.items + g.items, named: s.named + g.named }), { items: 0, named: 0 }),
);

const items = computed(() => [
  {
    group: null as number | null,
    label: t("groups.all"),
    count: `${n(total.value.named)}/${n(total.value.items)}`,
    items: total.value.items,
    named: total.value.named,
    edited: store.status.dirtyCount,
  },
  ...groups.value.map((g) => ({
    group: g.group as number | null,
    label: `${g.group}. ${t(`itemTypes.${g.group}`)}`,
    count: `${g.named}/${g.items}`,
    items: g.items,
    named: g.named,
    edited: g.edited,
  })),
]);
</script>

<template>
  <nav class="bg-card max-h-[30vh] overflow-auto border-b p-2 md:max-h-none md:border-r md:border-b-0" :aria-label="t('groups.label')">
    <ul>
      <li v-for="it in items" :key="String(it.group)">
        <button
          type="button"
          :aria-pressed="store.filter.group === it.group"
          :class="
            cn(
              'hover:bg-muted flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left',
              store.filter.group === it.group && 'bg-brand-soft text-brand font-semibold',
            )
          "
          @click="store.filter.group = it.group"
        >
          <span class="flex min-w-0 flex-1 flex-col gap-1">
            <span class="flex items-center justify-between gap-2">
              <span class="truncate">{{ it.label }}</span>
              <span class="text-muted-foreground shrink-0 text-xs font-normal tabular-nums">
                <span v-if="it.edited" class="text-brand font-semibold" :title="t('groups.dirtyTitle', { n: it.edited }, it.edited)">●{{ it.edited }} </span>
                {{ it.count }}
              </span>
            </span>
            <!-- translation progress: items with a name in the target language -->
            <span
              v-if="it.items"
              class="bg-muted block h-1 overflow-hidden rounded-sm"
              :title="t('groups.progressTitle', { named: it.named, items: it.items })"
            >
              <span class="bg-ok block h-full" :style="{ width: `${(it.named / it.items) * 100}%` }" />
            </span>
          </span>
        </button>
      </li>
    </ul>
  </nav>
</template>
