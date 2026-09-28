<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { exportOpen, exportTsv, mySlots } from "@/composables/actions";
import { useDocStore } from "@/stores/doc";

const { t, n } = useI18n();
const store = useDocStore();
type Scope = "view" | "named" | "mine";
const scope = ref<Scope>("view");

// Computed when the dialog opens (the lists do not change while it is open).
const lists = computed(() => {
  if (!exportOpen.value) return { view: [], named: [], mine: [] };
  return {
    view: store.visible.filter((r) => r.encoding !== "unknown").map((r) => r.slot),
    named: store.rows.filter((r) => r.encoding === "utf-8").map((r) => r.slot),
    mine: mySlots(),
  };
});
watch(exportOpen, (open) => {
  if (open) scope.value = lists.value.mine.length ? "mine" : "view";
});

const options = computed(() => [
  { value: "view" as Scope, label: t("exportDialog.scopeView", { n: n(lists.value.view.length) }), count: lists.value.view.length },
  { value: "named" as Scope, label: t("exportDialog.scopeNamed", { n: n(lists.value.named.length) }), count: lists.value.named.length },
  { value: "mine" as Scope, label: t("exportDialog.scopeMine", { n: n(lists.value.mine.length) }), count: lists.value.mine.length },
]);
const selected = computed(() => lists.value[scope.value]);
</script>

<template>
  <Dialog :open="exportOpen" @update:open="(o) => (exportOpen = o)">
    <DialogContent class="sm:max-w-lg" data-testid="export-dialog">
      <DialogHeader>
        <DialogTitle>{{ t("exportDialog.title") }}</DialogTitle>
        <DialogDescription>{{ t("exportDialog.body") }}</DialogDescription>
      </DialogHeader>
      <fieldset class="flex flex-col gap-2">
        <label v-for="o in options" :key="o.value" class="flex items-start gap-2 text-sm" :class="o.count ? '' : 'opacity-50'">
          <input v-model="scope" type="radio" name="export-scope" class="accent-primary mt-1" :value="o.value" :disabled="!o.count" :data-testid="`export-${o.value}`" />
          <span>
            {{ o.label }}
            <span v-if="o.value === 'mine' && store.translator" class="text-muted-foreground block text-xs">
              {{ t("exportDialog.mineHint", { name: store.translator }) }}
            </span>
          </span>
        </label>
      </fieldset>
      <DialogFooter>
        <Button variant="outline" @click="exportOpen = false">{{ t("common.cancel") }}</Button>
        <Button :disabled="!selected.length" data-testid="export-go" @click="exportTsv(selected)">{{ t("exportDialog.export") }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
