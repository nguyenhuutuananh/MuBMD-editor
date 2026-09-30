<script setup lang="ts">
import { useI18n } from "vue-i18n";
import type { RowState } from "@/lib/rows";

defineProps<{ state: RowState }>();
const { t } = useI18n();

const DOT: Record<RowState, string> = {
  missing: "border-muted-foreground/60 border bg-transparent",
  same: "bg-warn",
  kept: "bg-ok/40 ring-ok ring-1",
  translated: "bg-ok",
  extra: "bg-muted-foreground/50",
};
</script>

<template>
  <span class="inline-block size-2.5 shrink-0 rounded-full" :class="DOT[state]" :title="t(`state.${state}`)" :data-state="state" />
</template>
