<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import type { SourceKind } from "../../../src/shared/api";
import { groupLabel } from "@/lib/groups";
import { cn } from "@/lib/utils";
import { useDocStore } from "@/stores/doc";

const { t, n } = useI18n();
const store = useDocStore();

interface Item {
  kind: "all" | "source" | "group";
  source: SourceKind | null;
  group: number | null;
  label: string;
  file: string | null; // tooltip: the target file, or "no Game.vi.resx yet"
  total: number;
  translated: number;
  same: number;
  errors: number;
  warnings: number;
  dirty: number;
}

type Counts = Pick<Item, "total" | "translated" | "same" | "errors" | "warnings" | "dirty">;
const sum = (list: Counts[]): Counts => ({
  total: list.reduce((s, g) => s + g.total, 0),
  translated: list.reduce((s, g) => s + g.translated, 0),
  same: list.reduce((s, g) => s + g.same, 0),
  errors: list.reduce((s, g) => s + g.errors, 0),
  warnings: list.reduce((s, g) => s + g.warnings, 0),
  dirty: list.reduce((s, g) => s + g.dirty, 0),
});

// All, then per source (only with more than one source) a total line and its groups.
const items = computed<Item[]>(() => {
  void store.rev;
  const locale = store.open?.locale ?? "";
  // Rows with errors / warnings (not issue counts: a row with two errors counts once).
  const errors = new Array<number>(store.groups.length).fill(0);
  const warnings = new Array<number>(store.groups.length).fill(0);
  for (const r of store.rows) {
    if (r.worst === "error") errors[r.group]!++;
    else if (r.worst === "warning") warnings[r.group]!++;
  }
  const groups: Item[] = store.groups.map((g, i) => ({
    kind: "group",
    source: g.source,
    group: i,
    label: groupLabel(g),
    file: g.file ?? t("groups.noFile", { file: `${g.name}.${locale}.resx` }),
    total: g.progress.total,
    translated: g.progress.translated,
    same: g.progress.sameAsEn,
    errors: errors[i]!,
    warnings: warnings[i]!,
    dirty: g.dirty,
  }));
  const out: Item[] = [{ kind: "all", source: null, group: null, label: t("groups.all"), file: null, ...sum(groups) }];
  const sources = store.sources;
  for (const source of sources) {
    const mine = groups.filter((g) => g.source === source);
    if (sources.length > 1) out.push({ kind: "source", source, group: null, label: t(`groups.source.${source}`), file: null, ...sum(mine) });
    out.push(...mine);
  }
  return out;
});

const active = (it: Item) => store.filter.group === it.group && (it.group !== null || store.filter.source === it.source);
function choose(it: Item) {
  store.filter.source = it.source;
  store.filter.group = it.group;
}
const pct = (part: number, total: number) => (total ? `${(part / total) * 100}%` : "0%");
</script>

<template>
  <nav class="bg-card max-h-[30vh] overflow-auto border-b p-2 md:max-h-none md:border-r md:border-b-0" :aria-label="t('groups.label')">
    <ul>
      <li v-for="it in items" :key="`${it.kind}-${it.source}-${it.group}`" :class="it.kind === 'source' && 'mt-3 border-t pt-2'">
        <button
          type="button"
          :aria-pressed="active(it)"
          :title="it.file ?? undefined"
          :data-testid="it.kind === 'group' ? `group-${it.group}` : it.kind === 'source' ? `source-${it.source}` : 'group-all'"
          :class="
            cn(
              'hover:bg-muted flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left',
              it.kind !== 'group' && 'font-semibold',
              active(it) && 'bg-brand-soft text-brand font-semibold',
            )
          "
          @click="choose(it)"
        >
          <span class="flex min-w-0 flex-1 flex-col gap-1">
            <span class="flex items-center justify-between gap-2">
              <span class="truncate" :class="it.kind === 'group' && store.sources.length > 1 && 'pl-2'">{{ it.label }}</span>
              <span class="text-muted-foreground shrink-0 text-xs font-normal tabular-nums">
                <span v-if="it.dirty" class="text-brand font-semibold" :title="t('groups.dirtyTitle', { n: it.dirty }, it.dirty)">✎{{ it.dirty }} </span>
                <span v-if="it.errors" class="text-destructive font-semibold" :title="t('groups.errorsTitle', { n: it.errors }, it.errors)">●{{ it.errors }}</span>
                <span v-if="it.warnings" class="text-warn font-semibold" :title="t('groups.warningsTitle', { n: it.warnings }, it.warnings)"> ●{{ it.warnings }}</span>
                {{ n(it.translated) }}/{{ n(it.total) }}
              </span>
            </span>
            <!-- translated (green) and identical to English (amber) -->
            <span
              class="bg-muted flex h-1 overflow-hidden rounded-sm"
              :title="t('groups.progressTitle', { translated: it.translated, total: it.total, same: it.same })"
            >
              <span class="bg-ok block h-full" :style="{ width: pct(it.translated - it.same, it.total) }" />
              <span class="bg-warn block h-full" :style="{ width: pct(it.same, it.total) }" />
            </span>
          </span>
        </button>
      </li>
    </ul>
  </nav>
</template>
