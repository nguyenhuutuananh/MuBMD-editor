<script setup lang="ts">
import { computed } from "vue";
import { MAX_NAME_BYTES } from "../../../src/core/nameCodec";
import { byteLevel } from "@/lib/bytes";

const props = defineProps<{ bytes: number }>();
const level = computed(() => byteLevel(props.bytes));
const pct = computed(() => Math.min(100, (props.bytes / MAX_NAME_BYTES) * 100));
</script>

<template>
  <span class="flex items-center gap-1.5">
    <span
      class="w-5 text-right text-xs tabular-nums"
      :class="level === 'over' ? 'text-destructive' : level === 'near' ? 'text-warn' : 'text-muted-foreground'"
    >
      {{ bytes || "" }}
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
