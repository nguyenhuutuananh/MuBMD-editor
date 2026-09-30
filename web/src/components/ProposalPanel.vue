<script setup lang="ts">
// The undecided AI proposal of the selected row (.mumain-translator/proposals/): the proposed text
// with its checks, and accept / edit, then accept / skip.
import { Check, Pencil, Sparkles, X } from "@lucide/vue";
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { SEVERITY } from "../../../src/core/validate";
import type { RowIssue } from "../../../src/shared/api";
import RichText from "@/components/RichText.vue";
import { Button } from "@/components/ui/button";
import { acceptProposal, editProposal, rejectProposal } from "@/composables/actions";
import { fmtTime, glossaryHintText, issueText } from "@/i18n";
import { type Row, glossaryProblems } from "@/lib/rows";
import { useDocStore } from "@/stores/doc";

const props = defineProps<{ row: Row }>();
const { t } = useI18n();
const store = useDocStore();
const p = computed(() => {
  void store.rev;
  return store.proposalOf(props.row);
});
const hashBreaks = computed(() => (props.row.en ?? "").includes("##"));
const takeable = computed(() => p.value !== null && p.value.state !== "invalid" && p.value.state !== "unknown");
const glossary = computed(() => (p.value ? glossaryProblems({ ...props.row, value: p.value.value }, store.glossary?.entries ?? []) : []));
// The English text changed since the proposal was made (else: the translation did).
const englishChanged = computed(() => !!p.value?.english && p.value.english !== props.row.en);
const COLOR = { error: "text-destructive", warning: "text-warn", info: "text-muted-foreground" } as const;
const sevOf = (i: RowIssue) => SEVERITY[i[0]];
</script>

<template>
  <section v-if="p" class="border-brand/50 bg-brand-soft/40 flex flex-col gap-2 rounded-md border p-2.5" data-testid="proposal">
    <h3 class="flex items-center gap-1.5 text-xs font-semibold">
      <Sparkles class="text-brand size-3.5" />{{ t("proposals.title") }}
      <span class="text-muted-foreground ml-auto font-normal">{{ [p.by, fmtTime(p.createdAt)].filter(Boolean).join(" · ") }}</span>
    </h3>

    <p v-if="p.state !== 'ok'" class="text-xs" :class="p.state === 'same' ? 'text-muted-foreground' : 'text-warn'" data-testid="proposal-state">
      {{ t(`proposals.state.${p.state === "stale" && englishChanged ? "staleEnglish" : p.state}`) }}
      <template v-if="p.state === 'stale' && !englishChanged">
        {{ t("proposals.madeFrom") }} <RichText v-if="p.base" :text="p.base" /><span v-else class="italic">{{ t("grid.missing") }}</span>
      </template>
      <template v-if="p.state === 'stale' && englishChanged">
        {{ t("proposals.madeFrom") }} <RichText :text="p.english" />
      </template>
    </p>

    <p class="bg-card rounded-md border px-2.5 py-2" data-testid="proposal-value"><RichText :text="p.value" block :hash-breaks="hashBreaks" /></p>
    <p v-if="p.note" class="text-muted-foreground text-xs" data-testid="proposal-note">“{{ p.note }}”</p>

    <ul v-if="p.issues.length || glossary.length" class="flex flex-col gap-1 text-xs" data-testid="proposal-issues">
      <li v-for="(issue, i) in p.issues" :key="`i${i}`" :class="COLOR[sevOf(issue)]">{{ t(`severity.${sevOf(issue)}`) }}: {{ issueText(issue) }}</li>
      <li v-for="(h, i) in glossary" :key="`g${i}`" class="text-warn">{{ glossaryHintText(h) }}</li>
    </ul>
    <p v-else-if="takeable" class="text-ok text-xs">{{ t("proposals.noIssues") }}</p>

    <div class="flex flex-wrap gap-2">
      <Button size="sm" :disabled="!takeable" data-testid="proposal-accept" @click="acceptProposal(row.id)"><Check />{{ t("proposals.accept") }}</Button>
      <Button variant="outline" size="sm" :disabled="p.state === 'unknown'" data-testid="proposal-edit" @click="editProposal(row.id)">
        <Pencil />{{ t("proposals.editAccept") }}
      </Button>
      <Button variant="outline" size="sm" data-testid="proposal-reject" @click="rejectProposal(row.id)"><X />{{ t("proposals.reject") }}</Button>
    </div>
    <p v-if="p.older" class="text-muted-foreground text-xs">{{ t("proposals.older", { n: p.older }, p.older) }}</p>
    <p v-if="p.batchNote" class="text-muted-foreground text-xs">{{ t("proposals.batchNote", { note: p.batchNote }) }}</p>
  </section>
</template>
