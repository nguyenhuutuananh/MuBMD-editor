<script setup lang="ts">
import { Lock, LockOpen, Pencil, RotateCcw, Trash2 } from "@lucide/vue";
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { SEVERITY } from "../../../src/core/validate";
import { toIdentifier } from "../../../src/core/resxgen";
import { type RowIssue, STATUSES } from "../../../src/shared/api";
import ProposalPanel from "@/components/ProposalPanel.vue";
import RichText from "@/components/RichText.vue";
import StateDot from "@/components/StateDot.vue";
import StatusDot from "@/components/StatusDot.vue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MAX_NAME_CHARS, nameLength } from "../../../src/core/itemName";
import { canEdit, canKeep, cancelEdit, commitEditor, removeTranslation, revert, setNote, setStatus, startEdit, toggleKeep } from "@/composables/actions";
import { fmtTime, glossaryHintText, issueText } from "@/i18n";
import { groupLabel } from "@/lib/groups";
import { glossaryHints, itemId, liveIssues } from "@/lib/rows";
import { useDocStore } from "@/stores/doc";

const { t } = useI18n();
const store = useDocStore();
const row = computed(() => store.selected);
const group = computed(() => (row.value ? store.groups[row.value.group] : undefined));
const locale = computed(() => store.open?.locale ?? "");
const refLocale = computed(() => store.open?.reference ?? null);
const hashBreaks = computed(() => (row.value?.en ?? "").includes("##"));
const isItem = computed(() => row.value?.source === "items");
const identifier = computed(() => (row.value && row.value.en !== null && !isItem.value ? toIdentifier(row.value.key) : ""));
// "file, line N" (an item file has no line numbers).
const where = (file: string, line: number) => (line ? t("detail.where", { file, line }) : file);
// Item names: characters as the game counts them (of the text being typed while editing).
const nameChars = computed(() => (isItem.value && row.value ? nameLength(editing.value?.value ?? row.value.value ?? "") : null));
const fileOf = (l: string) => (l === "en" ? group.value?.enFile : group.value?.file) ?? `${group.value?.name}.${l}.resx`;

// While the selected row is being edited, the panel shows the text being typed and its checks.
const editing = computed(() => (row.value && store.editor?.id === row.value.id ? store.editor : null));
const draft = computed({
  get: () => editing.value?.value ?? "",
  set: (v: string) => {
    if (store.editor) store.editor.value = v;
  },
});
const issues = computed(() => (row.value && editing.value ? liveIssues(row.value, editing.value.value, locale.value).list : (row.value?.issues ?? [])));

const COLOR = { error: "text-destructive", warning: "text-warn", info: "text-muted-foreground" } as const;

// The note is saved when the field loses focus or on Enter.
const note = ref("");
watch(
  () => [row.value?.id, row.value?.record?.note] as const,
  () => (note.value = row.value?.record?.note ?? ""),
  { immediate: true },
);
const saveNote = () => {
  if (row.value && note.value.trim() !== (row.value.record?.note ?? "")) setNote(row.value.id, note.value);
};
// Glossary terms of the English text (while editing: of the text being typed).
const hints = computed(() => {
  const r = row.value;
  if (!r || !store.glossary) return [];
  return glossaryHints(editing.value ? { ...r, value: editing.value.value } : r, store.glossary.entries);
});
const sevOf = (i: RowIssue) => SEVERITY[i[0]];

// Enter saves (a line break is written as \n); Esc cancels. Composing with an IME: leave it alone.
function onKeydown(e: KeyboardEvent) {
  if (e.isComposing || e.keyCode === 229) return;
  if (e.key === "Enter") {
    e.preventDefault();
    commitEditor();
  } else if (e.key === "Escape") {
    e.preventDefault();
    cancelEdit();
  }
}
</script>

<template>
  <aside class="bg-card overflow-auto border-l p-4 text-[13px]" data-testid="detail">
    <p v-if="!row" class="text-muted-foreground">{{ t("detail.empty") }}</p>
    <div v-else class="flex flex-col gap-4">
      <div class="flex items-center gap-2">
        <StateDot :state="row.state" />
        <span class="font-semibold">{{ groupLabel(group) }}</span>
        <span class="text-muted-foreground">{{ t(`state.${row.state}`) }}</span>
        <span v-if="row.dirty" class="text-brand ml-auto text-xs font-semibold">● {{ t("detail.unsaved") }}</span>
      </div>

      <dl class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
        <template v-if="isItem">
          <dt class="text-muted-foreground">{{ t("detail.item") }}</dt>
          <dd class="font-mono text-xs" data-testid="detail-item">{{ itemId(row) }}</dd>
          <dt class="text-muted-foreground">{{ t("detail.file") }}</dt>
          <dd class="font-mono text-xs break-all">{{ group?.file }}</dd>
        </template>
        <template v-else-if="row.key !== row.en">
          <dt class="text-muted-foreground">{{ t("detail.key") }}</dt>
          <dd class="font-mono text-xs break-all" data-testid="detail-key">{{ row.key }}</dd>
        </template>
        <template v-if="row.en !== null && !isItem">
          <dt class="text-muted-foreground">{{ t("detail.identifier") }}</dt>
          <dd class="font-mono text-xs break-all">{{ identifier || t("detail.noIdentifier") }}</dd>
        </template>
        <template v-if="row.legacyIds.length">
          <dt class="text-muted-foreground">{{ t("detail.legacyIds") }}</dt>
          <dd class="font-mono text-xs">{{ row.legacyIds.join(", ") }}</dd>
        </template>
      </dl>

      <section v-if="row.en !== null">
        <h3 class="text-muted-foreground mb-1 flex justify-between text-xs font-semibold">
          <span>{{ t("detail.en") }}</span>
          <span v-if="!isItem" class="font-normal">{{ where(fileOf("en"), row.enLine) }}</span>
        </h3>
        <p class="bg-muted rounded-md px-2.5 py-2"><RichText :text="row.en" block :hash-breaks="hashBreaks" /></p>
      </section>

      <section>
        <h3 class="text-muted-foreground mb-1 flex justify-between text-xs font-semibold">
          <span>{{ t("detail.translation", { locale }) }}</span>
          <span v-if="row.line && !row.dirty" class="font-normal">{{ where(fileOf(locale), row.line) }}</span>
          <span
            v-if="nameChars !== null"
            class="font-normal tabular-nums"
            :class="nameChars > MAX_NAME_CHARS ? 'text-destructive font-semibold' : ''"
            data-testid="detail-length"
          >
            {{ t("detail.length", { n: nameChars, max: MAX_NAME_CHARS }) }}
          </span>
        </h3>
        <template v-if="editing">
          <textarea
            id="detail-editor"
            v-model="draft"
            rows="4"
            class="focus-visible:ring-ring/50 w-full resize-y rounded-md border px-2.5 py-2 outline-none focus-visible:ring-2"
            spellcheck="false"
            :placeholder="t('editor.placeholder')"
            data-testid="detail-editor"
            @keydown="onKeydown"
          />
          <p v-if="editing.proposal" class="text-brand text-xs" data-testid="detail-proposal-hint">{{ t("proposals.editHint") }}</p>
          <p class="text-muted-foreground text-xs">{{ isItem ? t("detail.editHintItem") : t("detail.editHint") }}</p>
        </template>
        <p v-else-if="row.value !== null" class="rounded-md border px-2.5 py-2" data-testid="detail-value">
          <RichText :text="row.value" block :hash-breaks="hashBreaks" />
        </p>
        <p v-else class="text-muted-foreground italic">{{ t("grid.missing") }}</p>
        <p v-if="row.dirty && !editing" class="text-muted-foreground mt-1 text-xs">
          {{ t("detail.savedWas") }}
          <RichText v-if="row.saved !== null" :text="row.saved" block :hash-breaks="hashBreaks" />
          <span v-else class="italic">{{ t("grid.missing") }}</span>
        </p>
      </section>

      <ProposalPanel v-if="!editing" :row="row" />

      <div class="flex flex-wrap gap-2" data-testid="detail-actions">
        <Button v-if="canEdit(row) && !editing" size="sm" data-testid="action-edit" @click="startEdit(row.id)"><Pencil />{{ t("detail.edit") }}</Button>
        <Button v-if="canKeep(row)" variant="outline" size="sm" :title="t('detail.keepTitle')" data-testid="action-keep" @click="toggleKeep(row.id)">
          <template v-if="row.keep"><LockOpen />{{ t("detail.unkeep") }}</template>
          <template v-else><Lock />{{ t("detail.keep") }}</template>
        </Button>
        <Button v-if="row.value !== null" variant="outline" size="sm" :title="t('detail.removeTitle')" data-testid="action-remove" @click="removeTranslation(row.id)">
          <Trash2 />{{ t("detail.remove") }}
        </Button>
        <Button v-if="row.dirty" variant="outline" size="sm" data-testid="action-revert" @click="revert(row.id)"><RotateCcw />{{ t("detail.revert") }}</Button>
      </div>

      <section v-if="row.en !== null" class="flex flex-col gap-2">
        <h3 class="text-muted-foreground text-xs font-semibold">{{ t("detail.status") }}</h3>
        <div class="flex flex-wrap gap-1.5" role="radiogroup" :aria-label="t('detail.status')">
          <Button
            v-for="(s, i) in STATUSES"
            :key="s"
            size="sm"
            variant="outline"
            :class="row.status === s && 'border-brand bg-brand-soft ring-brand/40 ring-2'"
            role="radio"
            :aria-checked="row.status === s"
            :title="`Alt+${i + 1}`"
            :data-testid="`detail-status-${s}`"
            @click="setStatus([row], s)"
          >
            <StatusDot :status="s" with-label />
          </Button>
        </div>
        <Input
          v-model="note"
          :placeholder="t('detail.notePlaceholder')"
          :aria-label="t('detail.note')"
          data-testid="detail-note"
          @blur="saveNote"
          @keydown.enter.prevent="saveNote"
        />
        <p v-if="row.record?.translator || row.record?.updatedAt" class="text-muted-foreground text-xs">
          {{ t("detail.lastBy", { name: row.record.translator || "?", time: fmtTime(row.record.updatedAt) }) }}
        </p>
      </section>

      <section v-if="hints.length">
        <h3 class="text-muted-foreground mb-1 text-xs font-semibold">{{ t("detail.glossary") }}</h3>
        <ul class="flex flex-col gap-1" data-testid="detail-glossary">
          <li v-for="(h, i) in hints" :key="i" :class="h.kind === 'ok' ? 'text-ok' : h.suggested ? 'text-muted-foreground' : 'text-warn'">
            {{ glossaryHintText(h) }}<span v-if="h.suggested" class="text-xs"> ({{ t("glossary.status.suggested") }})</span>
            <span v-if="h.note" class="text-muted-foreground"> — {{ h.note }}</span>
          </li>
        </ul>
      </section>

      <section v-if="refLocale && row.reference !== null">
        <h3 class="text-muted-foreground mb-1 text-xs font-semibold">{{ t("detail.reference", { locale: refLocale }) }}</h3>
        <p class="rounded-md border border-dashed px-2.5 py-2"><RichText :text="row.reference" block :hash-breaks="hashBreaks" /></p>
      </section>

      <section>
        <h3 class="text-muted-foreground mb-1 text-xs font-semibold">{{ t("detail.issues") }}</h3>
        <p v-if="!issues.length" class="text-muted-foreground">{{ t("detail.noIssues") }}</p>
        <ul v-else class="flex flex-col gap-2" data-testid="detail-issues">
          <li v-for="(issue, i) in issues" :key="i" class="flex flex-col">
            <span :class="['text-xs font-semibold', COLOR[sevOf(issue)]]">
              {{ t(`severity.${sevOf(issue)}`) }}
              <span class="text-muted-foreground font-normal">· {{ t("detail.inFile", { file: fileOf(issue[1]) }) }}</span>
            </span>
            <span>{{ issueText(issue) }}</span>
          </li>
        </ul>
      </section>

      <p v-if="isItem" class="text-muted-foreground text-xs">{{ t("detail.itemHelp") }}</p>
      <template v-else>
        <p class="text-muted-foreground text-xs">{{ t("detail.tokens") }}</p>
        <p class="text-muted-foreground text-xs">{{ t("detail.keys") }}</p>
      </template>
    </div>
  </aside>
</template>
