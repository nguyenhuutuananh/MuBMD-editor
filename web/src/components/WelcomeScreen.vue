<script setup lang="ts">
import { FolderOpen } from "@lucide/vue";
import { onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { isFallback, isWeb } from "@/lib/api";
import { displayPath } from "@/lib/paths";
import { backToFile, openPath, pickAndOpen, welcomeError } from "@/composables/actions";
import { useDocStore } from "@/stores/doc";

const { t } = useI18n();
const store = useDocStore();
const path = ref("");
const input = ref<InstanceType<typeof Input> | null>(null);

function submit() {
  const p = path.value.trim().replace(/^"(.*)"$/, "$1");
  if (p) openPath(p);
}

onMounted(() => (input.value?.$el as HTMLInputElement | undefined)?.focus());
</script>

<template>
  <main class="flex flex-1 justify-center overflow-auto px-4 pt-[10vh] pb-6">
    <section class="bg-card flex h-fit w-full max-w-xl flex-col gap-4 rounded-xl border p-7">
      <Button v-if="store.file" variant="link" class="h-auto self-start p-0" @click="backToFile">{{ t("welcome.back") }}</Button>
      <h1 class="text-2xl font-bold">{{ t("welcome.title") }}</h1>
      <i18n-t keypath="welcome.hint" tag="p" class="text-muted-foreground">
        <template #path><code class="bg-muted rounded px-1 font-mono text-[0.92em]">Data/Local/Item.bmd</code></template>
      </i18n-t>
      <p v-if="isFallback" class="bg-muted rounded-md px-3 py-2 text-[13px]" data-testid="fallback-hint">{{ t("welcome.fallbackHint") }}</p>
      <p v-else-if="isWeb" class="text-muted-foreground text-[13px]">{{ t("welcome.webHint") }}</p>
      <Button class="self-start" data-testid="pick" @click="pickAndOpen()">
        <FolderOpen />{{ isFallback ? t("welcome.pickUpload") : isWeb ? t("welcome.pickFolder") : t("welcome.pick") }}
      </Button>
      <div v-if="isWeb && !isFallback" class="-mt-2 flex flex-col items-start">
        <Button variant="link" class="h-auto p-0" data-testid="pick-file" @click="pickAndOpen('bmd-file')">{{ t("welcome.pickFile") }}</Button>
        <p class="text-muted-foreground text-xs">{{ t("welcome.pickFileHint") }}</p>
      </div>

      <!-- a typed path only means something to the desktop server -->
      <form v-if="!isWeb" class="flex flex-col gap-1.5" @submit.prevent="submit">
        <Label for="open-path" class="text-muted-foreground text-xs">{{ t("welcome.pasteLabel") }}</Label>
        <div class="flex gap-2">
          <Input
            id="open-path"
            ref="input"
            v-model="path"
            class="min-w-0 flex-1 font-mono text-[13px]"
            spellcheck="false"
            autocomplete="off"
            :placeholder="t('welcome.placeholder')"
          />
          <Button type="submit" variant="outline">{{ t("welcome.open") }}</Button>
        </div>
      </form>

      <p v-if="welcomeError" role="alert" class="bg-bad-soft text-destructive rounded-md px-3 py-2" data-testid="open-error">
        {{ welcomeError }}
      </p>

      <div v-if="store.recent.length">
        <h2 class="text-muted-foreground mt-2 mb-1 text-xs font-semibold">{{ t("welcome.recent") }}</h2>
        <ul class="flex flex-col gap-1 text-[13px]">
          <li v-for="p in store.recent" :key="p">
            <button type="button" class="text-brand text-left break-all hover:underline" data-testid="recent" @click="openPath(p)">
              {{ displayPath(p) }}
            </button>
          </li>
        </ul>
      </div>
    </section>
  </main>
</template>
