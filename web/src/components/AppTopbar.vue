<script setup lang="ts">
import { Redo2, Undo2, UserRound } from "@lucide/vue";
import { computed, watchEffect } from "vue";
import { useI18n } from "vue-i18n";
import LanguageSwitch from "@/components/LanguageSwitch.vue";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { askTranslator, reload, saveAs, saveFile, showWelcome, undoRedo } from "@/composables/actions";
import { isFallback } from "@/lib/api";
import { displayPath } from "@/lib/paths";
import { useDocStore } from "@/stores/doc";

const { t } = useI18n();
const store = useDocStore();
const inWorkspace = computed(() => store.view === "workspace" && store.file !== null);
const dirty = computed(() => store.status.dirtyCount);

watchEffect(() => {
  const f = store.file;
  document.title = f && inWorkspace.value ? `${dirty.value ? "• " : ""}${f.fileName} - MuBMD-editor` : "MuBMD-editor";
});
</script>

<template>
  <header class="bg-card flex flex-wrap items-center gap-x-4 gap-y-2 border-b px-4 py-2">
    <div class="font-bold tracking-tight">{{ t("app.name") }}</div>

    <div v-if="inWorkspace && store.file" class="flex min-w-0 flex-1 items-center gap-2.5 overflow-hidden">
      <span class="font-semibold">{{ store.file.fileName }}</span>
      <Tooltip>
        <TooltipTrigger as-child>
          <Badge
            :class="store.file.checksumValid ? 'bg-ok-soft text-ok border-transparent' : 'bg-bad-soft text-destructive border-transparent'"
            data-testid="checksum"
          >
            {{ store.file.checksumValid ? t("topbar.checksumOk") : t("topbar.checksumBad") }}
          </Badge>
        </TooltipTrigger>
        <TooltipContent class="max-w-sm">
          {{ store.file.checksumValid ? t("topbar.checksumOkTitle") : t("topbar.checksumBadTitle") }}
        </TooltipContent>
      </Tooltip>
      <Tooltip v-if="isFallback">
        <TooltipTrigger as-child>
          <Badge variant="outline" class="border-warn text-warn" data-testid="browser-copy">{{ t("topbar.browserCopy") }}</Badge>
        </TooltipTrigger>
        <TooltipContent class="max-w-sm">{{ t("topbar.browserCopyTitle") }}</TooltipContent>
      </Tooltip>
      <!-- rtl truncates the start of the path; LRM marks keep the character order -->
      <span class="text-muted-foreground hidden min-w-0 truncate text-xs md:inline" dir="rtl" :title="displayPath(store.file.path)">
        &lrm;{{ displayPath(store.file.path) }}&lrm;
      </span>
    </div>

    <div class="ml-auto flex flex-wrap items-center gap-2">
      <template v-if="inWorkspace">
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
              <Button variant="outline" size="icon-sm" class="rounded-r-none" :disabled="!store.status.canUndo" :aria-label="t('topbar.undo')" @click="undoRedo('undo')">
                <Undo2 />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{{ t("topbar.undo") }}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger as-child>
              <Button variant="outline" size="icon-sm" class="rounded-l-none border-l-0" :disabled="!store.status.canRedo" :aria-label="t('topbar.redo')" @click="undoRedo('redo')">
                <Redo2 />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{{ t("topbar.redo") }}</TooltipContent>
          </Tooltip>
        </div>
        <Button size="sm" :disabled="dirty === 0" :title="t('topbar.saveTitle')" data-testid="save" @click="saveFile()">
          {{ t("topbar.save") }}
        </Button>
        <Button variant="outline" size="sm" @click="saveAs">{{ t("topbar.saveAs") }}</Button>
        <Button variant="outline" size="sm" :title="t('topbar.translatorTitle')" data-testid="translator" @click="askTranslator">
          <UserRound />
          {{ store.translator ? t("topbar.translator", { name: store.translator }) : t("topbar.setTranslator") }}
        </Button>
        <Button variant="outline" size="sm" :title="t('topbar.reloadTitle')" @click="reload">{{ t("topbar.reload") }}</Button>
        <Button variant="outline" size="sm" data-testid="open-other" @click="showWelcome">{{ t("topbar.openOther") }}</Button>
      </template>
      <LanguageSwitch />
    </div>
  </header>
</template>
