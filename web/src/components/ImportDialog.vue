<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { KeyRef, MergeItem } from "../../../src/shared/api";
import RichText from "@/components/RichText.vue";
import StatusDot from "@/components/StatusDot.vue";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { applyImport, importPreview } from "@/composables/actions";
import { issueText } from "@/i18n";
import { cn } from "@/lib/utils";

const { t } = useI18n();
const idOf = (i: MergeItem) => `${i.group}\u0000${i.key}`;
const take = ref(new Set<string>());

watch(importPreview, (p) => {
  take.value = new Set(p?.items.filter((i) => i.take).map(idOf) ?? []);
});

const items = computed(() => importPreview.value?.items ?? []);
const selectable = (i: MergeItem) => i.kind !== "invalid";
const count = computed(() => take.value.size);

function toggle(i: MergeItem, on: boolean) {
  const next = new Set(take.value);
  if (on) next.add(idOf(i));
  else next.delete(idOf(i));
  take.value = next;
}
const setAll = (on: boolean, filter: (i: MergeItem) => boolean = () => true) => {
  const next = new Set(take.value);
  for (const i of items.value) if (selectable(i) && filter(i)) on ? next.add(idOf(i)) : next.delete(idOf(i));
  take.value = next;
};
const apply = () => applyImport(items.value.filter((i) => take.value.has(idOf(i))).map((i): KeyRef => [i.group, i.key]));

const KIND_CLASS: Record<MergeItem["kind"], string> = {
  apply: "bg-brand-soft text-brand",
  conflict: "bg-bad-soft text-destructive",
  status: "bg-ok-soft text-ok",
  invalid: "bg-muted text-muted-foreground",
};

const close = (open: boolean) => {
  if (!open) importPreview.value = null;
};
</script>

<template>
  <Dialog :open="importPreview !== null" @update:open="close">
    <DialogContent v-if="importPreview" class="flex max-h-[90vh] flex-col sm:max-w-5xl" data-testid="import-dialog">
      <DialogHeader>
        <DialogTitle>{{ t("importDialog.title") }}</DialogTitle>
        <DialogDescription as="div" class="flex flex-col gap-1.5 text-left">
          <p class="font-mono text-xs break-all">{{ t("importDialog.file", { file: importPreview.fileName }) }}</p>
          <p class="text-foreground font-medium" data-testid="import-summary">{{ t("importDialog.summary", { ...importPreview.counts }) }}</p>
          <p>{{ t("importDialog.skipped", { ...importPreview.counts }) }}</p>
          <p v-if="importPreview.problems.length" class="text-warn">
            {{ t("importDialog.problems", { n: importPreview.problems.length }, importPreview.problems.length) }}
          </p>
          <p v-if="!importPreview.hasBase" class="bg-bad-soft text-destructive rounded px-2 py-1">{{ t("importDialog.noBase") }}</p>
        </DialogDescription>
      </DialogHeader>

      <p v-if="!items.length" class="text-muted-foreground py-6 text-center">{{ t("importDialog.nothing") }}</p>
      <template v-else>
        <div class="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" @click="setAll(true)">{{ t("importDialog.selectAll") }}</Button>
          <Button variant="outline" size="sm" @click="setAll(false)">{{ t("importDialog.selectNone") }}</Button>
          <Button v-if="importPreview.counts.conflict" variant="outline" size="sm" @click="setAll(true, (i) => i.kind === 'conflict')">
            {{ t("importDialog.takeConflicts") }}
          </Button>
        </div>
        <div class="min-h-0 flex-1 overflow-auto rounded-md border">
          <table class="w-full text-[13px]">
            <thead class="bg-muted text-muted-foreground sticky top-0 text-left text-xs">
              <tr>
                <th class="w-8 p-2" />
                <th class="p-2">{{ t("importDialog.key") }}</th>
                <th class="p-2" />
                <th class="p-2">{{ t("grid.en") }}</th>
                <th class="p-2">{{ t("importDialog.ours") }}</th>
                <th class="p-2">{{ t("importDialog.theirs") }}</th>
                <th class="p-2">{{ t("importDialog.base") }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="i in items" :key="idOf(i)" :class="cn('border-t align-top', !selectable(i) && 'opacity-60')" :data-kind="i.kind" data-testid="import-row">
                <td class="p-2">
                  <input
                    type="checkbox"
                    class="accent-primary"
                    :disabled="!selectable(i)"
                    :checked="take.has(idOf(i))"
                    :aria-label="i.key"
                    @change="(e) => toggle(i, (e.target as HTMLInputElement).checked)"
                  />
                </td>
                <td class="text-muted-foreground max-w-40 p-2 text-xs break-all">{{ i.group }} · {{ i.key }}</td>
                <td class="p-2">
                  <span :class="cn('rounded px-1.5 py-0.5 text-xs whitespace-nowrap', KIND_CLASS[i.kind])">{{ t(`importDialog.kind.${i.kind}`) }}</span>
                </td>
                <td class="text-muted-foreground p-2"><RichText :text="i.english" block /></td>
                <td class="p-2">
                  <RichText v-if="i.ours !== null" :text="i.ours" block />
                  <span v-else class="text-muted-foreground italic">{{ t("grid.missing") }}</span>
                  <StatusDot v-if="i.kind === 'status'" :status="i.oursStatus" with-label />
                </td>
                <td class="p-2">
                  <RichText :text="i.theirs" block :class="i.kind !== 'status' ? 'font-semibold' : ''" />
                  <StatusDot v-if="i.theirsStatus" :status="i.theirsStatus" with-label />
                  <div v-if="i.translator" class="text-muted-foreground text-xs">{{ t("importDialog.by", { name: i.translator }) }}</div>
                  <div v-for="e in i.errors" :key="e.code" class="text-destructive text-xs">{{ issueText([e.code, "", e.params]) }}</div>
                  <div v-if="i.kind === 'invalid'" class="text-destructive text-xs">{{ t("importDialog.invalidChar") }}</div>
                </td>
                <td class="text-muted-foreground p-2">{{ i.base === null ? "—" : i.base || t("grid.missing") }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>

      <DialogFooter>
        <Button variant="outline" @click="close(false)">{{ t("common.cancel") }}</Button>
        <Button :disabled="!count" data-testid="import-apply" @click="apply">{{ t("importDialog.apply", { n: count }, count) }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
