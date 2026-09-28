<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { MAX_NAME_BYTES, checkName } from "../../../src/core/nameCodec";
import { Button } from "@/components/ui/button";
import { revert, startEdit } from "@/composables/actions";
import { fmtTime, issueText } from "@/i18n";
import { byteLevel } from "@/lib/bytes";
import { useDocStore } from "@/stores/doc";

const { t } = useI18n();
const store = useDocStore();

const row = computed(() => {
  void store.rev;
  const s = store.selectedSlot;
  const r = s === null ? undefined : store.rows[s];
  return r ? { ...r } : null; // bản sao để computed đổi khi dòng được patch
});

const facts = computed(() => {
  const r = row.value;
  if (!r) return [];
  const out: [string, string][] = [];
  if (r.edit) {
    out.push([t("detail.original"), r.edit.originalEncoding === "unknown" ? t("detail.originalNonUtf8") : r.edit.originalText || t("grid.empty")]);
    out.push([t("detail.editedBy"), `${r.edit.translator || "?"}${r.edit.at ? `, ${fmtTime(r.edit.at)}` : ""}`]);
  }
  out.push([t("detail.group"), `${r.itemType}. ${t(`itemTypes.${r.itemType}`)}`]);
  out.push([t("detail.typeIndex"), `${r.itemType} / ${r.itemIndex}`]);
  out.push([t("detail.slot"), `#${r.slot}`]);
  out.push([t("detail.encoding"), t(`encoding.${r.encoding}`)]);
  out.push([t("detail.length"), t("detail.lengthValue", { bytes: r.byteLength, max: MAX_NAME_BYTES, chars: [...r.text].length })]);
  return out;
});

const notes = computed(() => {
  const r = row.value;
  if (!r) return [];
  return [r.encoding === "unknown" ? t("detail.nonUtf8Note") : "", ...r.issues.map((c) => t(`issues.${c}`))].filter(Boolean);
});

// Cảnh báo theo thời gian thực của tên đang gõ.
const live = computed(() => {
  const ed = store.editor;
  if (!ed || ed.slot !== store.selectedSlot) return null;
  const c = checkName(ed.value);
  const over = c.byteLength - MAX_NAME_BYTES;
  return {
    level: byteLevel(c.byteLength),
    title:
      over > 0
        ? t("detail.editingOver", { bytes: c.byteLength, max: MAX_NAME_BYTES, over })
        : t("detail.editing", { bytes: c.byteLength, max: MAX_NAME_BYTES, left: -over }),
    issues: c.issues.map((i) => ({ text: issueText(i), severity: i.severity })),
  };
});
</script>

<template>
  <aside class="bg-card overflow-auto border-l p-4" :aria-label="t('detail.label')" data-testid="detail">
    <p v-if="!row" class="text-muted-foreground">{{ t("detail.none") }}</p>
    <template v-else>
      <h2 class="mb-3 text-lg font-bold break-words">{{ row.encoding === "empty" ? t("grid.empty") : row.text }}</h2>
      <dl class="mb-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-[13px]">
        <template v-for="[k, v] in facts" :key="k">
          <dt class="text-muted-foreground">{{ k }}</dt>
          <dd>{{ v }}</dd>
        </template>
      </dl>
      <ul v-if="notes.length" class="text-warn mb-3 list-disc pl-5 text-[13px]">
        <li v-for="m in notes" :key="m">{{ m }}</li>
      </ul>
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
      <div class="mb-3 flex flex-wrap gap-2">
        <Button variant="outline" size="sm" @click="startEdit(row.slot)">{{ t("detail.edit") }}</Button>
        <Button v-if="row.edit" variant="outline" size="sm" data-testid="revert" @click="revert(row.slot)">{{ t("detail.revert") }}</Button>
      </div>
      <p class="text-muted-foreground text-xs">{{ t("detail.help") }}</p>
    </template>
  </aside>
</template>
