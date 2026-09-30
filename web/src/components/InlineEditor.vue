<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { MAX_NAME_CHARS, checkName } from "../../../src/core/nameCodec";
import { anyDialogOpen, cancelEdit, commitEditor, moveEdit } from "@/composables/actions";
import { issueText } from "@/i18n";
import { lengthLevel } from "@/lib/length";
import type { Row } from "@/lib/search";
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
const check = computed(() => checkName(value.value));
const level = computed(() => lengthLevel(check.value.length));

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

// Clicking away: save if valid; if invalid, keep the editor open so the user can come back.
function onBlur() {
  const ed = store.editor;
  setTimeout(() => {
    if (store.editor === ed && document.activeElement !== input.value && !anyDialogOpen()) commitEditor({ quiet: true });
  }, 0);
}

onMounted(() => {
  input.value?.focus();
  input.value?.select();
});
</script>

<template>
  <div
    class="bg-card col-span-2 -mx-1.5 flex h-8 items-center gap-1.5 rounded-md border-2 px-1.5 shadow-md"
    :class="check.ok ? 'border-ring' : 'border-destructive'"
    data-testid="inline-editor"
    @click.stop
    @dblclick.stop
  >
    <input
      ref="input"
      v-model="value"
      type="text"
      class="min-w-0 flex-1 bg-transparent py-0.5 font-semibold outline-none"
      spellcheck="false"
      autocomplete="off"
      :aria-label="t('editor.aria', { type: props.row.itemType, index: props.row.itemIndex })"
      :aria-invalid="!check.ok"
      :placeholder="props.row.english ?? ''"
      :title="check.issues.map(issueText).join('\n')"
      @keydown="onKeydown"
      @blur="onBlur"
    />
    <span
      class="text-xs whitespace-nowrap tabular-nums"
      :class="level === 'over' ? 'text-destructive font-bold' : level === 'near' ? 'text-warn font-semibold' : 'text-muted-foreground'"
      data-testid="editor-counter"
    >
      {{ check.length }}/{{ MAX_NAME_CHARS }}
    </span>
  </div>
</template>
