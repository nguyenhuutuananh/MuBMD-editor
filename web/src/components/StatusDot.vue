<script setup lang="ts">
import { useI18n } from "vue-i18n";
import type { Status } from "../../../src/shared/api";

defineProps<{ status: Status; withLabel?: boolean }>();
const { t } = useI18n();

const DOT: Record<Status, string> = {
  untranslated: "border-muted-foreground/60 border bg-transparent",
  translated: "bg-brand",
  reviewed: "bg-ok",
};
</script>

<template>
  <span class="flex min-w-0 items-center gap-1.5" :title="t(`status.${status}`)" :data-status="status">
    <span class="size-2.5 shrink-0 rounded-full" :class="DOT[status]" />
    <span v-if="withLabel" class="truncate text-xs" :class="status === 'untranslated' ? 'text-muted-foreground' : ''">
      {{ t(`status.${status}`) }}
    </span>
  </span>
</template>
