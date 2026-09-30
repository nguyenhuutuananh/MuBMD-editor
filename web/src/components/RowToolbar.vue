<script setup lang="ts">
import { BookOpen, CheckCheck, ChevronDown, Download, RefreshCw, Sparkles, Upload } from "@lucide/vue";
import { useDebounceFn } from "@vueuse/core";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { STATUSES } from "../../../src/shared/api";
import StateDot from "@/components/StateDot.vue";
import StatusDot from "@/components/StatusDot.vue";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  acceptCleanProposals,
  cleanProposals,
  exportOpen,
  glossaryOpen,
  registerSearch,
  reloadProposals,
  select,
  setStatus,
  startImport,
} from "@/composables/actions";
import { isFallback } from "@/lib/api";
import type { SeverityFilter, StateFilter, StatusFilter } from "@/lib/rows";
import { useDocStore } from "@/stores/doc";

const { t, n } = useI18n();
const store = useDocStore();
const query = ref(store.filter.query);
const search = ref<InstanceType<typeof Input> | null>(null);

const apply = () => {
  if (store.filter.query !== query.value) store.filter.query = query.value;
};
const applyDebounced = useDebounceFn(apply, 80);
// The query can also be changed from outside (e.g. cleared after an import).
watch(
  () => store.filter.query,
  (q) => {
    if (q !== query.value) query.value = q;
  },
);

// Enter / ↓ in the search box: jump to the first result row.
function toResults(e: KeyboardEvent) {
  if (e.isComposing) return;
  e.preventDefault();
  apply();
  store.refilter(); // now: the watcher on the query runs later, and `visible` would be stale
  const first = store.visible[0];
  if (first) select(first.id, true);
  document.getElementById("grid-body")?.focus();
}

// "Has an AI proposal" needs the side data folder, which the fallback mode does not upload.
const states: StateFilter[] = ["any", "missing", "translated", "same", "kept", "extra", "dirty", ...(isFallback ? [] : (["proposal"] as const))];
const severities: SeverityFilter[] = ["any", "error", "problems", "issues", "clean", "glossary"];
const statusFilters: StatusFilter[] = ["any", ...STATUSES];
const markList = (status: (typeof STATUSES)[number]) => setStatus(store.visible.filter((r) => r.en !== null), status);
const proposalCount = computed(() => store.proposals?.items.length ?? 0);
// Counted when the menu opens (the list changes with every edit).
const cleanCount = ref(0);
const onMenu = (open: boolean) => {
  if (open) cleanCount.value = cleanProposals().length;
};
const toggleProposals = () => (store.filter.state = store.filter.state === "proposal" ? "any" : "proposal");

onMounted(() =>
  registerSearch(() => {
    const el = search.value?.$el as HTMLInputElement | undefined;
    el?.focus();
    el?.select();
  }),
);
onBeforeUnmount(() => registerSearch(null));
</script>

<template>
  <div class="flex flex-wrap items-center gap-2 border-b px-3 py-2">
    <Input
      ref="search"
      v-model="query"
      type="search"
      class="min-w-0 flex-[1_1_280px]"
      spellcheck="false"
      autocomplete="off"
      :placeholder="t('toolbar.search')"
      :aria-label="t('toolbar.searchLabel')"
      data-testid="search"
      @update:model-value="applyDebounced"
      @keydown.enter="toResults"
      @keydown.down="toResults"
    />
    <Select v-model="store.filter.state">
      <SelectTrigger class="w-auto" :aria-label="t('toolbar.stateLabel')" data-testid="state-filter"><SelectValue /></SelectTrigger>
      <SelectContent>
        <SelectItem v-for="s in states" :key="s" :value="s" :data-testid="`state-${s}`">
          <Sparkles v-if="s === 'proposal'" class="text-brand" />
          <StateDot v-else-if="s !== 'any' && s !== 'dirty'" :state="s" />{{ t(`toolbar.state.${s}`) }}
        </SelectItem>
      </SelectContent>
    </Select>
    <Select v-model="store.filter.status">
      <SelectTrigger class="w-auto" :aria-label="t('toolbar.statusLabel')" data-testid="status-filter"><SelectValue /></SelectTrigger>
      <SelectContent>
        <SelectItem v-for="s in statusFilters" :key="s" :value="s" :data-testid="`status-filter-${s}`">
          <StatusDot v-if="s !== 'any'" :status="s" with-label />
          <template v-else>{{ t("toolbar.statusAny") }}</template>
        </SelectItem>
      </SelectContent>
    </Select>
    <Select v-model="store.filter.severity">
      <SelectTrigger class="w-auto" :aria-label="t('toolbar.severityLabel')" data-testid="severity-filter"><SelectValue /></SelectTrigger>
      <SelectContent>
        <SelectItem v-for="s in severities" :key="s" :value="s" :disabled="s === 'glossary' && !store.glossary" :data-testid="`severity-${s}`">
          {{ t(`toolbar.severity.${s}`) }}
        </SelectItem>
      </SelectContent>
    </Select>
    <Button
      v-if="proposalCount"
      variant="outline"
      size="sm"
      :class="store.filter.state === 'proposal' && 'border-brand bg-brand-soft'"
      :title="t('proposals.countTitle')"
      data-testid="proposal-count"
      @click="toggleProposals"
    >
      <Sparkles class="text-brand" />{{ t("proposals.count", { n: n(proposalCount) }, proposalCount) }}
    </Button>
    <span class="text-muted-foreground ml-auto text-xs tabular-nums" aria-live="polite" data-testid="result-count">
      {{ t("toolbar.rows", { n: n(store.visible.length) }, store.visible.length) }}
    </span>
    <DropdownMenu @update:open="onMenu">
      <DropdownMenuTrigger as-child>
        <Button variant="outline" data-testid="actions">{{ t("toolbar.actions") }}<ChevronDown /></Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" class="min-w-64">
        <DropdownMenuItem data-testid="action-export" @select="exportOpen = true"><Download />{{ t("actions.export") }}</DropdownMenuItem>
        <DropdownMenuItem data-testid="action-import" @select="startImport"><Upload />{{ t("actions.import") }}</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem data-testid="action-glossary" @select="glossaryOpen = true"><BookOpen />{{ t("actions.glossary") }}</DropdownMenuItem>
        <template v-if="!isFallback">
          <DropdownMenuSeparator />
          <DropdownMenuItem data-testid="action-proposals-reload" @select="reloadProposals()"><RefreshCw />{{ t("proposals.reload") }}</DropdownMenuItem>
          <DropdownMenuItem :disabled="!cleanCount" data-testid="action-proposals-accept-clean" @select="acceptCleanProposals">
            <CheckCheck />{{ t("proposals.acceptClean", { n: n(cleanCount) }, cleanCount) }}
          </DropdownMenuItem>
        </template>
        <DropdownMenuSeparator />
        <DropdownMenuLabel class="text-muted-foreground text-xs font-normal">
          {{ t("actions.markList", { n: n(store.visible.length) }, store.visible.length) }}
        </DropdownMenuLabel>
        <DropdownMenuItem v-for="s in STATUSES" :key="s" :disabled="!store.visible.length" :data-testid="`mark-${s}`" @select="markList(s)">
          <StatusDot :status="s" with-label />
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  </div>
</template>
