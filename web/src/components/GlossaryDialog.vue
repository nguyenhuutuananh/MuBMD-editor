<script setup lang="ts">
import { Check, Plus, Trash2, Undo2 } from "@lucide/vue";
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { type GlossaryEntry, isConfirmed } from "../../../src/core/glossary";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { glossaryOpen, openGlossaryFile, saveGlossary } from "@/composables/actions";
import { tr } from "@/i18n";
import { ask } from "@/lib/dialogs";
import { fold } from "@/lib/rows";
import { useDocStore } from "@/stores/doc";

const { t } = useI18n();
const store = useDocStore();

// Edited locally; written to the file only on Save.
const entries = ref<GlossaryEntry[]>([]);
const creating = ref(false);
const dirty = ref(false);
const query = ref("");
const statusFilter = ref<"all" | "confirmed" | "suggested">("all");
const draft = ref({ term: "", translation: "", note: "", category: "", source: "" });

function reset() {
  entries.value = (store.glossary?.entries ?? []).map((e) => ({ ...e }));
  dirty.value = false;
  creating.value = false;
}
watch(glossaryOpen, (open) => open && reset());
watch(() => store.glossary, reset);

const hasGlossary = computed(() => store.glossary !== null || creating.value);
const legacy = computed(() => store.glossary?.format === "legacy-csv");
const counts = computed(() => {
  const confirmed = entries.value.filter(isConfirmed).length;
  return { confirmed, suggested: entries.value.length - confirmed };
});
const shown = computed(() => {
  const q = fold(query.value.trim());
  const f = statusFilter.value;
  return entries.value
    .map((e, i) => ({ e, i }))
    .filter(({ e }) => f === "all" || (f === "confirmed") === isConfirmed(e))
    .filter(({ e }) => !q || fold(`${e.term} ${e.translation ?? ""} ${e.note} ${e.category} ${e.source ?? ""}`).includes(q));
});

// Confirm a suggestion (the translation becomes the agreed one), or take a confirmation back.
function toggleStatus(i: number) {
  entries.value = entries.value.map((e, j) => (j === i ? { ...e, status: isConfirmed(e) ? "suggested" : "confirmed" } : e));
  dirty.value = true;
}

function add() {
  const term = draft.value.term.trim();
  if (!term) return;
  const translation = draft.value.translation.trim();
  const source = draft.value.source.trim();
  entries.value = [
    ...entries.value,
    {
      term,
      translation: translation && translation !== term ? translation : null,
      note: draft.value.note.trim(),
      category: draft.value.category.trim(),
      ...(source ? { source } : {}),
      status: "confirmed",
    },
  ];
  draft.value = { term: "", translation: "", note: "", category: draft.value.category, source: draft.value.source };
  dirty.value = true;
}

function remove(i: number) {
  entries.value = entries.value.filter((_, j) => j !== i);
  dirty.value = true;
}

async function save(forceAsk = false) {
  if (await saveGlossary(entries.value, forceAsk)) {
    dirty.value = false;
    creating.value = false;
  }
}

function startNew() {
  entries.value = [];
  creating.value = true;
  dirty.value = true;
}

async function close(open: boolean) {
  if (open) return;
  if (dirty.value && entries.value.length) {
    const r = await ask({
      title: tr("glossary.discardTitle"),
      body: [tr("glossary.discardBody")],
      actions: [
        { id: "cancel", label: tr("common.cancel") },
        { id: "discard", label: tr("glossary.discard"), kind: "danger" },
      ],
    });
    if (r.action !== "discard") return;
  }
  glossaryOpen.value = false;
}
</script>

<template>
  <Dialog :open="glossaryOpen" @update:open="close">
    <DialogContent class="flex max-h-[90vh] flex-col sm:max-w-5xl" data-testid="glossary-dialog">
      <DialogHeader>
        <DialogTitle>{{ t("glossary.title") }}</DialogTitle>
        <DialogDescription as="div" class="flex flex-col gap-1 text-left">
          <p v-if="!hasGlossary">{{ t("glossary.empty") }}</p>
          <template v-else>
            <p v-if="store.glossary && !creating" class="font-mono text-xs break-all">{{ t("glossary.file", { file: store.glossary.path }) }}</p>
            <p>
              {{ t("glossary.count", { n: entries.length }, entries.length) }}
              <span data-testid="glossary-counts">· {{ t("glossary.counts", { confirmed: counts.confirmed, suggested: counts.suggested }) }}</span>
              <span v-if="dirty" class="text-brand"> · {{ t("glossary.unsaved") }}</span>
            </p>
            <p v-if="legacy && !creating" class="bg-bad-soft text-destructive rounded px-2 py-1">{{ t("glossary.legacy") }}</p>
          </template>
        </DialogDescription>
      </DialogHeader>

      <div v-if="!hasGlossary" class="flex flex-wrap gap-2">
        <Button data-testid="glossary-open" @click="openGlossaryFile">{{ t("glossary.open") }}</Button>
        <Button variant="outline" data-testid="glossary-new" @click="startNew">{{ t("glossary.create") }}</Button>
      </div>

      <template v-else>
        <form class="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1fr_1fr_0.8fr_0.8fr_auto]" @submit.prevent="add">
          <Input v-model="draft.term" :placeholder="t('glossary.term')" data-testid="glossary-term" />
          <Input
            v-model="draft.translation"
            :placeholder="t('glossary.translation')"
            :title="t('glossary.translationHint')"
            data-testid="glossary-translation"
          />
          <Input v-model="draft.note" :placeholder="t('glossary.note')" />
          <Input v-model="draft.category" :placeholder="t('glossary.category')" />
          <Input v-model="draft.source" :placeholder="t('glossary.source')" />
          <Button type="submit" variant="outline" :disabled="!draft.term.trim()" data-testid="glossary-add"><Plus />{{ t("glossary.add") }}</Button>
        </form>
        <div class="flex gap-2">
          <Input v-model="query" type="search" class="flex-1" :placeholder="t('glossary.search')" />
          <Select v-model="statusFilter">
            <SelectTrigger class="w-auto" data-testid="glossary-status-filter"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{{ t("glossary.statusAll") }}</SelectItem>
              <SelectItem value="confirmed" data-testid="glossary-status-confirmed">{{ t("glossary.status.confirmed") }}</SelectItem>
              <SelectItem value="suggested" data-testid="glossary-status-suggested">{{ t("glossary.status.suggested") }}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div class="min-h-0 flex-1 overflow-auto rounded-md border">
          <table class="w-full text-[13px]">
            <thead class="bg-muted text-muted-foreground sticky top-0 text-left text-xs">
              <tr>
                <th class="p-2">{{ t("glossary.term") }}</th>
                <th class="p-2">{{ t("glossary.translation") }}</th>
                <th class="p-2">{{ t("glossary.note") }}</th>
                <th class="p-2">{{ t("glossary.category") }}</th>
                <th class="p-2">{{ t("glossary.source") }}</th>
                <th class="w-20 p-2" />
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="{ e, i } in shown"
                :key="`${i}-${e.term}`"
                class="border-t align-top"
                :class="!isConfirmed(e) && 'bg-muted/40'"
                data-testid="glossary-row"
              >
                <td class="p-2 font-medium">
                  {{ e.term }}
                  <span v-if="!isConfirmed(e)" class="text-warn block text-[11px] font-normal">{{ t("glossary.status.suggested") }}</span>
                </td>
                <td class="p-2">
                  <span v-if="e.translation">{{ e.translation }}</span>
                  <span v-else class="text-muted-foreground italic">{{ t("glossary.keep") }}</span>
                </td>
                <td class="text-muted-foreground p-2">{{ e.note }}</td>
                <td class="text-muted-foreground p-2">{{ e.category }}</td>
                <td class="text-muted-foreground p-2">{{ e.source }}</td>
                <td class="flex p-1">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    :title="isConfirmed(e) ? t('glossary.unconfirm') : t('glossary.confirm')"
                    :aria-label="isConfirmed(e) ? t('glossary.unconfirm') : t('glossary.confirm')"
                    data-testid="glossary-toggle"
                    @click="toggleStatus(i)"
                  >
                    <Undo2 v-if="isConfirmed(e)" /><Check v-else class="text-ok" />
                  </Button>
                  <Button variant="ghost" size="icon-sm" :aria-label="t('glossary.remove')" @click="remove(i)"><Trash2 /></Button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>

      <DialogFooter class="flex-wrap gap-2">
        <Button v-if="hasGlossary" variant="outline" class="sm:mr-auto" @click="openGlossaryFile">{{ t("glossary.openOther") }}</Button>
        <Button variant="outline" @click="close(false)">{{ t("common.close") }}</Button>
        <Button v-if="hasGlossary && !legacy && !creating && store.glossary" variant="outline" @click="save(true)">{{ t("glossary.saveAs") }}</Button>
        <Button v-if="hasGlossary" :disabled="!dirty && !legacy" data-testid="glossary-save" @click="save(legacy || creating)">
          {{ legacy || creating ? t("glossary.saveAs") : t("glossary.save") }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
