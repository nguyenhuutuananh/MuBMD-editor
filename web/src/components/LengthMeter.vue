<script setup lang="ts">
import { computed } from "vue";
import { MAX_NAME_CHARS } from "../../../src/core/nameCodec";
import { lengthLevel } from "@/lib/length";

const props = defineProps<{ length: number }>();
const level = computed(() => lengthLevel(props.length));
const pct = computed(() => Math.min(100, (props.length / MAX_NAME_CHARS) * 100));
</script>

<template>
  <span class="flex items-center gap-1.5">
    <span
      class="w-5 text-right text-xs tabular-nums"
      :class="level === 'over' ? 'text-destructive' : level === 'near' ? 'text-warn' : 'text-muted-foreground'"
    >
      {{ length || "" }}
    </span>
    <span class="bg-muted h-1 flex-1 overflow-hidden rounded-sm">
      <span
        class="block h-full"
        :class="level === 'over' ? 'bg-destructive' : level === 'near' ? 'bg-warn' : 'bg-muted-foreground'"
        :style="{ width: `${pct}%` }"
      />
    </span>
  </span>
</template>
