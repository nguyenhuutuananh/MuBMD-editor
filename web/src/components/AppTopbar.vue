<script setup lang="ts">
import { Redo2, RefreshCw, Undo2, UserRound } from "@lucide/vue";
import { computed, watchEffect } from "vue";
import { useI18n } from "vue-i18n";
import LanguageSwitch from "@/components/LanguageSwitch.vue";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { askTranslator, registrationOpen, reload, saveAll, setReference, showWelcome, undoRedo } from "@/composables/actions";
import { fmtTime } from "@/i18n";
import { isFallback } from "@/lib/api";
import { localeName } from "@/lib/locales";
import { displayPath } from "@/lib/paths";
import { useDocStore } from "@/stores/doc";

const { t } = useI18n();
const store = useDocStore();
const open = computed(() => (store.view === "workspace" ? store.open : null));
const NONE = "__none__"; // Select values cannot be null
const dirty = computed(() => store.status.dirtyCount);
// The game's language list does not know this locale yet (null files = not a MuMain checkout: no notice).
const unregistered = computed(() => {
  const r = store.registration;
  return r !== null && (r.optionWindow?.registered === false || r.emitter?.registered === false);
});

// Reference candidates: every locale of the folder except en and the one being translated.
const references = computed(() =>
  (store.open?.folder.locales ?? []).map((l) => l.code).filter((c) => c !== "en" && c !== store.open?.locale),
);
const reference = computed({
  get: () => store.open?.reference ?? NONE,
  set: (v: string) => setReference(v === NONE ? null : v),
});

watchEffect(() => {
  const o = open.value;
  document.title = o ? `${dirty.value ? "• " : ""}${o.locale} - ${o.folder.path.split(/[\\/]/).slice(-1).join("/").replace(/@\d+$/, "")} - MuMain-translator` : "MuMain-translator";
});
</script>

<template>
  <header class="bg-card flex flex-wrap items-center gap-x-4 gap-y-2 border-b px-4 py-2">
    <div class="font-bold tracking-tight">{{ t("app.name") }}</div>

    <div v-if="open" class="flex min-w-0 flex-1 items-center gap-2.5 overflow-hidden">
      <Badge class="bg-brand-soft text-brand border-transparent" data-testid="locale">
        {{ open.locale }} · {{ localeName(open.locale) }}
      </Badge>
      <Tooltip v-if="open.folder.resx">
        <TooltipTrigger as-child>
          <Badge variant="outline" data-testid="badge-resx">{{ t("groups.source.resx") }}</Badge>
        </TooltipTrigger>
        <TooltipContent class="max-w-sm">{{ t("topbar.resxTitle", { dir: open.folder.resx.rel || "." }) }}</TooltipContent>
      </Tooltip>
      <Tooltip v-if="open.folder.items">
        <TooltipTrigger as-child>
          <Badge variant="outline" data-testid="badge-items">{{ t("groups.source.items") }} · {{ t(`layout.${open.folder.items.layout}`) }}</Badge>
        </TooltipTrigger>
        <TooltipContent class="max-w-sm">{{ t("topbar.itemsTitle", { dir: open.folder.items.rel || "." }) }}</TooltipContent>
      </Tooltip>
      <Tooltip v-if="isFallback">
        <TooltipTrigger as-child>
          <Badge variant="outline" class="border-warn text-warn" data-testid="browser-copy">{{ t("topbar.browserCopy") }}</Badge>
        </TooltipTrigger>
        <TooltipContent class="max-w-sm">{{ t("topbar.browserCopyTitle") }}</TooltipContent>
      </Tooltip>
      <Tooltip v-if="store.buildErrors">
        <TooltipTrigger as-child>
          <Badge class="bg-bad-soft text-destructive border-transparent" data-testid="build-errors">
            {{ t("topbar.buildFails", { n: store.buildErrors }, store.buildErrors) }}
          </Badge>
        </TooltipTrigger>
        <TooltipContent class="max-w-sm">{{ t("topbar.buildFailsTitle") }}</TooltipContent>
      </Tooltip>
      <Badge
        v-if="unregistered"
        as="button"
        class="bg-bad-soft text-destructive cursor-pointer border-transparent"
        data-testid="unregistered"
        @click="registrationOpen = true"
      >
        {{ t("topbar.unregistered") }}
      </Badge>
      <!-- rtl truncates the start of the path; LRM marks keep the character order -->
      <span
        class="text-muted-foreground hidden min-w-0 truncate text-xs md:inline"
        dir="rtl"
        :title="`${displayPath(open.folder.path)}\n${t('topbar.loadedAt', { time: fmtTime(open.loadedAt) })}`"
      >
        &lrm;{{ displayPath(open.folder.path) }}&lrm;
      </span>
    </div>

    <div class="ml-auto flex flex-wrap items-center gap-2">
      <template v-if="open">
        <span
          class="text-xs whitespace-nowrap"
          :class="dirty ? 'text-brand font-semibold' : 'text-muted-foreground'"
          aria-live="polite"
          data-testid="dirty-status"
        >
          {{ dirty ? `● ${t("topbar.dirty", { n: dirty }, dirty)}` : t("topbar.allSaved") }}
        </span>
        <div class="flex">
          <Tooltip>
            <TooltipTrigger as-child>
              <Button variant="outline" size="icon-sm" class="rounded-r-none" :disabled="!store.status.canUndo" :aria-label="t('topbar.undo')" data-testid="undo" @click="undoRedo('undo')">
                <Undo2 />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{{ t("topbar.undo") }}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger as-child>
              <Button variant="outline" size="icon-sm" class="rounded-l-none border-l-0" :disabled="!store.status.canRedo" :aria-label="t('topbar.redo')" data-testid="redo" @click="undoRedo('redo')">
                <Redo2 />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{{ t("topbar.redo") }}</TooltipContent>
          </Tooltip>
        </div>
        <Button size="sm" :disabled="dirty === 0" :title="t('topbar.saveTitle')" data-testid="save" @click="saveAll()">{{ t("topbar.save") }}</Button>
        <Button variant="outline" size="sm" :title="t('topbar.translatorTitle')" data-testid="translator" @click="askTranslator">
          <UserRound />{{ store.translator || t("topbar.setTranslator") }}
        </Button>
        <label v-if="references.length" class="text-muted-foreground flex items-center gap-1.5 text-xs">
          {{ t("topbar.reference") }}
          <Select v-model="reference">
            <SelectTrigger size="sm" class="w-auto" data-testid="reference"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem :value="NONE">{{ t("topbar.referenceNone") }}</SelectItem>
              <SelectItem v-for="c in references" :key="c" :value="c">{{ c }} · {{ localeName(c) }}</SelectItem>
            </SelectContent>
          </Select>
        </label>
        <Button variant="outline" size="sm" :title="t('topbar.reloadTitle')" data-testid="reload" @click="reload">
          <RefreshCw />{{ t("topbar.reload") }}
        </Button>
        <Button variant="outline" size="sm" data-testid="open-other" @click="showWelcome">{{ t("topbar.openOther") }}</Button>
      </template>
      <LanguageSwitch />
    </div>
  </header>
</template>
