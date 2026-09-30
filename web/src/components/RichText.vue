<script setup lang="ts">
// A text with the parts the game interprets made visible: placeholders highlighted, line breaks
// shown as symbols (↵ for \n, # in Item Shop texts, ⏎ for a real line break), stray backslashes
// marked. `block`: wrap lines (detail panel); otherwise one truncated line (grid).
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { tokenize } from "@/lib/rows";
import { cn } from "@/lib/utils";

const props = defineProps<{ text: string; block?: boolean; hashBreaks?: boolean }>();
const { t } = useI18n();
const tokens = computed(() => tokenize(props.text, props.hashBreaks));

const SHOW: Record<string, string> = { br: "↵", nl: "⏎", hash: "#", bad: "\\" };
const CLASS: Record<string, string> = {
  ph: "bg-brand-soft text-brand rounded-sm px-0.5",
  br: "text-brand",
  hash: "text-brand font-semibold",
  nl: "text-warn font-semibold",
  bad: "bg-bad-soft text-destructive rounded-sm px-0.5 font-semibold",
};
</script>

<template>
  <span :class="cn(block ? 'break-words whitespace-pre-wrap' : 'truncate whitespace-pre')">
    <template v-for="(tok, i) in tokens" :key="i">
      <template v-if="tok.kind === 'text'">{{ tok.text }}</template>
      <span v-else :class="CLASS[tok.kind]" :title="t(`token.${tok.kind}`)">{{ tok.kind === "ph" ? tok.text : SHOW[tok.kind] }}</span>
      <br v-if="block && (tok.kind === 'br' || tok.kind === 'nl' || (tok.kind === 'hash' && hashBreaks))" />
    </template>
  </span>
</template>
