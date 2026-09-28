<script setup lang="ts">
import { ChevronDown, Download, FileText, Upload, X } from "@lucide/vue";
import { useDebounceFn } from "@vueuse/core";
import { ref } from "vue";
import { useI18n } from "vue-i18n";
import { STATUSES } from "../../../src/shared/api";
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
import { chooseReference, clearReference, exportOpen, select, setStatus, startImport } from "@/composables/actions";
import type { Problem, SlotScope, StatusFilter } from "@/lib/search";
import { useDocStore } from "@/stores/doc";

const { t, n } = useI18n();
const store = useDocStore();
const query = ref(store.filter.query);
const search = ref<InstanceType<typeof Input> | null>(null);

const apply = () => {
  if (store.filter.query !== query.value) store.filter.query = query.value;
};
const applyDebounced = useDebounceFn(apply, 80);

// Enter / ↓ in the search box: jump to the first result row.
function toResults(e: KeyboardEvent) {
  if (e.isComposing) return;
  e.preventDefault();
  apply();
  const first = store.visible[0];
  if (first) select(first.slot, true);
  document.getElementById("grid-body")?.focus();
}

const scopes: SlotScope[] = ["named", "all", "empty"];
const statusFilters: StatusFilter[] = ["any", ...STATUSES];
const openExport = () => (exportOpen.value = true);
const markList = (status: (typeof STATUSES)[number]) => setStatus(store.visible.map((r) => r.slot), status);
const problems: { value: Problem; key: string }[] = [
  { value: "any", key: "any" },
  { value: "edited", key: "edited" },
  { value: "issues", key: "issues" },
  { value: "near-limit", key: "nearLimit" },
  { value: "unknown-encoding", key: "unknownEncoding" },
];

defineExpose({
  focusSearch() {
    const el = search.value?.$el as HTMLInputElement | undefined;
    el?.focus();
    el?.select();
  },
});
</script>

<template>
  <div class="flex flex-wrap items-center gap-2 border-b px-3 py-2">
    <Input
      ref="search"
      v-model="query"
      type="search"
      class="min-w-0 flex-[1_1_260px]"
      spellcheck="false"
      autocomplete="off"
      :placeholder="t('toolbar.search')"
      :aria-label="t('toolbar.searchLabel')"
      data-testid="search"
      @update:model-value="applyDebounced"
      @keydown.enter="toResults"
      @keydown.down="toResults"
    />
    <Select v-model="store.filter.scope">
      <SelectTrigger class="w-auto" :aria-label="t('toolbar.scopeLabel')" data-testid="scope"><SelectValue /></SelectTrigger>
      <SelectContent>
        <SelectItem v-for="s in scopes" :key="s" :value="s">{{ t(`toolbar.scope.${s}`) }}</SelectItem>
      </SelectContent>
    </Select>
    <Select v-model="store.filter.problem">
      <SelectTrigger class="w-auto" :aria-label="t('toolbar.problemLabel')" data-testid="problem"><SelectValue /></SelectTrigger>
      <SelectContent>
        <SelectItem v-for="p in problems" :key="p.value" :value="p.value" :data-testid="`problem-${p.value}`">
          {{ t(`toolbar.problem.${p.key}`) }}
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
    <span class="text-muted-foreground ml-auto text-xs tabular-nums" aria-live="polite" data-testid="result-count">
      {{ t("toolbar.rows", { n: n(store.visible.length) }, store.visible.length) }}
    </span>
    <DropdownMenu>
      <DropdownMenuTrigger as-child>
        <Button variant="outline" data-testid="actions">{{ t("toolbar.actions") }}<ChevronDown /></Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" class="min-w-64">
        <DropdownMenuItem data-testid="action-export" @select="openExport"><Download />{{ t("actions.export") }}</DropdownMenuItem>
        <DropdownMenuItem data-testid="action-import" @select="startImport"><Upload />{{ t("actions.import") }}</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem data-testid="action-reference" @select="chooseReference"><FileText />{{ t("actions.reference") }}</DropdownMenuItem>
        <DropdownMenuItem v-if="store.reference" @select="clearReference"><X />{{ t("actions.clearReference") }}</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel class="text-muted-foreground text-xs font-normal">
          {{ t("actions.markList", { n: n(store.visible.length) }, store.visible.length) }}
        </DropdownMenuLabel>
        <DropdownMenuItem
          v-for="s in STATUSES"
          :key="s"
          :disabled="!store.visible.length"
          :data-testid="`mark-${s}`"
          @select="markList(s)"
        >
          <StatusDot :status="s" with-label />
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  </div>
</template>
