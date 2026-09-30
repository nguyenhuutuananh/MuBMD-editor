<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { checkGlossary } from "../../../src/core/glossary";
import { MAX_NAME_CHARS, checkName } from "../../../src/core/nameCodec";
import { STATUSES } from "../../../src/shared/api";
import StatusDot from "@/components/StatusDot.vue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { revert, setNote, setStatus, startEdit } from "@/composables/actions";
import { fmtTime, glossaryHintText, issueText } from "@/i18n";
import { lengthLevel } from "@/lib/length";
import { sourceOf } from "@/lib/search";
import { useDocStore } from "@/stores/doc";

const { t } = useI18n();
const store = useDocStore();

const row = computed(() => {
  void store.rev;
  const s = store.selectedSlot;
  const r = s === null ? undefined : store.rows[s];
  return r ? { ...r } : null; // copy, so the computed changes when the row is patched in place
});

const facts = computed(() => {
  const r = row.value;
  if (!r) return [];
  const out: [string, string][] = [];
  out.push([t("detail.english"), r.english || "—"]);
  if (r.reference) out.push([t("detail.reference"), r.reference]);
  if (r.edit) {
    out.push([t("detail.original"), r.edit.originalText || t("grid.empty")]);
    out.push([t("detail.editedBy"), `${r.edit.translator || "?"}${r.edit.at ? `, ${fmtTime(r.edit.at)}` : ""}`]);
  }
  out.push([t("detail.group"), `${r.itemType}. ${t(`itemTypes.${r.itemType}`)}`]);
  out.push([t("detail.typeIndex"), `${r.itemType} / ${r.itemIndex}`]);
  out.push([t("detail.slot"), `#${r.slot}`]);
  out.push([t("detail.length"), t("detail.lengthValue", { chars: r.length, max: MAX_NAME_CHARS })]);
  return out;
});

const notes = computed(() => {
  const r = row.value;
  if (!r) return [];
  return r.issues.map((c) => t(`issues.${c}`));
});

// Glossary hints for the name (or the name being typed) against the reference name.
const glossaryHints = computed(() => {
  const r = row.value;
  const entries = store.glossary?.entries ?? [];
  if (!r || !entries.length) return [];
  const name = store.editor?.slot === r.slot ? store.editor.value : r.text;
  if (!name) return [];
  return checkGlossary(entries, name, sourceOf(r)).map((h) => ({ text: glossaryHintText(h), ok: h.kind === "ok", note: h.note }));
});

// Note field: edited locally, saved on Enter / blur.
const note = ref("");
// Separate sources: each is compared by value, so an unrelated update of the row (e.g. a status
// change landing while typing) does not wipe the note being typed.
watch(
  [() => row.value?.slot, () => row.value?.record.note],
  ([, n]) => (note.value = n ?? ""),
  { immediate: true },
);
function saveNote() {
  const r = row.value;
  if (r && note.value.trim() !== r.record.note) setNote(r.slot, note.value);
}

// Live feedback for the name being typed.
const live = computed(() => {
  const ed = store.editor;
  if (!ed || ed.slot !== store.selectedSlot) return null;
  const c = checkName(ed.value);
  const over = c.length - MAX_NAME_CHARS;
  return {
    level: lengthLevel(c.length),
    title:
      over > 0
        ? t("detail.editingOver", { chars: c.length, max: MAX_NAME_CHARS, over })
        : t("detail.editing", { chars: c.length, max: MAX_NAME_CHARS, left: -over }),
    issues: c.issues.map((i) => ({ text: issueText(i), severity: i.severity })),
  };
});
</script>

<template>
  <aside class="bg-card overflow-auto border-l p-4" :aria-label="t('detail.label')" data-testid="detail">
    <p v-if="!row" class="text-muted-foreground">{{ t("detail.none") }}</p>
    <template v-else>
      <h2 class="mb-3 text-lg font-bold break-words" :class="row.text ? '' : 'text-muted-foreground italic'">{{ row.text || t("grid.empty") }}</h2>
      <div class="mb-3">
        <p class="text-muted-foreground mb-1 text-xs">{{ t("detail.status") }}</p>
        <div class="flex w-fit overflow-hidden rounded-md border" role="radiogroup" :aria-label="t('detail.status')">
          <button
            v-for="s in STATUSES"
            :key="s"
            type="button"
            role="radio"
            :aria-checked="row.record.status === s"
            class="hover:bg-muted border-r px-2.5 py-1 last:border-r-0"
            :class="row.record.status === s ? 'bg-brand-soft font-semibold' : ''"
            :data-testid="`detail-status-${s}`"
            @click="setStatus([row.slot], s)"
          >
            <StatusDot :status="s" with-label />
          </button>
        </div>
        <p class="text-muted-foreground mt-1 text-[11px]">{{ t("status.shortcut") }}</p>
      </div>
      <dl class="mb-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-[13px]">
        <template v-for="[k, v] in facts" :key="k">
          <dt class="text-muted-foreground">{{ k }}</dt>
          <dd>{{ v }}</dd>
        </template>
      </dl>
      <ul v-if="notes.length" class="text-warn mb-3 list-disc pl-5 text-[13px]">
        <li v-for="m in notes" :key="m">{{ m }}</li>
      </ul>
      <div v-if="glossaryHints.length" class="mb-3" data-testid="glossary-hints">
        <p class="text-muted-foreground mb-1 text-xs">{{ t("detail.glossary") }}</p>
        <ul class="flex flex-col gap-1 text-[13px]">
          <li
            v-for="h in glossaryHints"
            :key="h.text"
            :class="h.ok ? 'text-ok' : 'bg-bad-soft text-destructive rounded px-2 py-1'"
            :title="h.note"
          >
            {{ h.text }}
          </li>
        </ul>
      </div>
      <div v-if="live" class="mb-3" data-testid="live-issues">
        <p class="mb-1.5 text-[13px] font-semibold" :class="live.level === 'over' ? 'text-destructive' : live.level === 'near' ? 'text-warn' : ''">
          {{ live.title }}
        </p>
        <ul v-if="live.issues.length" class="list-disc pl-5 text-[13px]">
          <li
            v-for="i in live.issues"
            :key="i.text"
            :class="i.severity === 'error' ? 'bg-bad-soft text-destructive rounded px-2 py-1' : 'text-warn'"
          >
            {{ i.text }}
          </li>
        </ul>
      </div>
      <div class="mb-3 flex flex-col gap-1">
        <label for="detail-note" class="text-muted-foreground text-xs">{{ t("detail.note") }}</label>
        <Input
          id="detail-note"
          v-model="note"
          class="h-8 text-[13px]"
          :placeholder="t('detail.notePlaceholder')"
          data-testid="detail-note"
          @keydown.enter="(e: KeyboardEvent) => !e.isComposing && saveNote()"
          @blur="saveNote"
        />
      </div>
      <div class="mb-3 flex flex-wrap gap-2">
        <Button variant="outline" size="sm" @click="startEdit(row.slot)">{{ t("detail.edit") }}</Button>
        <Button v-if="row.dirty" variant="outline" size="sm" data-testid="revert" @click="revert(row.slot)">{{ t("detail.revert") }}</Button>
      </div>
      <p class="text-muted-foreground text-xs">{{ t("detail.help") }}</p>
    </template>
  </aside>
</template>
