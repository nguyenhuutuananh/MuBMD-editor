<script setup lang="ts">
import { useDebounceFn } from "@vueuse/core";
import { ref } from "vue";
import { useI18n } from "vue-i18n";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { select } from "@/composables/actions";
import type { Problem, SlotScope } from "@/lib/search";
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
    <span class="text-muted-foreground ml-auto text-xs tabular-nums" aria-live="polite" data-testid="result-count">
      {{ t("toolbar.rows", { n: n(store.visible.length) }, store.visible.length) }}
    </span>
  </div>
</template>
