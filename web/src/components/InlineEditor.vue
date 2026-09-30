<script setup lang="ts">
// The translation cell while editing. One line: a line break is typed as \n, like in the en
// files. The checks run while typing (same code as the server) and color the border.
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { anyDialogOpen, cancelEdit, commitEditor, moveEdit } from "@/composables/actions";
import { issueText } from "@/i18n";
import { MAX_NAME_CHARS, nameLength } from "../../../src/core/itemName";
import { liveIssues } from "@/lib/rows";
import type { Row } from "@/lib/rows";
import { useDocStore } from "@/stores/doc";

const props = defineProps<{ row: Row }>();
const { t } = useI18n();
const store = useDocStore();
const input = ref<HTMLInputElement | null>(null);

const value = computed({
  get: () => store.editor?.value ?? "",
  set: (v: string) => {
    if (store.editor) store.editor.value = v;
  },
});
const issues = computed(() => liveIssues(props.row, value.value, store.open?.locale ?? ""));
const worst = computed(() => issues.value.worst);
// Item names: the game shows at most 49 characters.
const length = computed(() => (props.row.source === "items" ? nameLength(value.value) : null));

function onKeydown(e: KeyboardEvent) {
  // Composing with a Vietnamese IME (Telex/VNI, Unikey...): Enter/Tab confirms the text, it must not save.
  if (e.isComposing || e.keyCode === 229) return;
  if (e.key === "Enter" || e.key === "Tab") {
    e.preventDefault();
    moveEdit(e.shiftKey ? -1 : 1);
  } else if (e.key === "Escape") {
    e.preventDefault();
    cancelEdit();
    document.getElementById("grid-body")?.focus();
  } else if ((e.key === "ArrowDown" || e.key === "ArrowUp") && (e.altKey || e.ctrlKey)) {
    e.preventDefault();
    moveEdit(e.key === "ArrowDown" ? 1 : -1);
  }
}

// Clicking away saves (unless it went to the detail panel's text box, which edits the same value).
function onBlur() {
  const ed = store.editor;
  setTimeout(() => {
    const active = document.activeElement;
    if (store.editor !== ed || active === input.value || active?.id === "detail-editor" || anyDialogOpen()) return;
    commitEditor();
  }, 0);
}

onMounted(() => {
  input.value?.focus();
  input.value?.select();
});
</script>

<template>
  <div
    class="bg-card -mx-1.5 flex h-8 min-w-0 items-center rounded-md border-2 px-1.5 shadow-md"
    :class="worst === 'error' ? 'border-destructive' : worst === 'warning' ? 'border-warn' : 'border-ring'"
    data-testid="inline-editor"
    @click.stop
    @dblclick.stop
  >
    <input
      ref="input"
      v-model="value"
      type="text"
      class="min-w-0 flex-1 bg-transparent py-0.5 outline-none"
      spellcheck="false"
      autocomplete="off"
      :aria-label="t('editor.aria', { key: props.row.key })"
      :aria-invalid="worst === 'error'"
      :placeholder="props.row.source === 'items' ? (props.row.en ?? '') : t('editor.placeholder')"
      :title="issues.list.map(issueText).join('\n')"
      @keydown="onKeydown"
      @blur="onBlur"
    />
    <span
      v-if="length !== null"
      class="ml-1.5 text-xs whitespace-nowrap tabular-nums"
      :class="length > MAX_NAME_CHARS ? 'text-destructive font-bold' : length >= 40 ? 'text-warn font-semibold' : 'text-muted-foreground'"
      data-testid="editor-counter"
    >
      {{ length }}/{{ MAX_NAME_CHARS }}
    </span>
  </div>
</template>
