<script setup lang="ts">
import { FolderOpen } from "@lucide/vue";
import { computed, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { isLocaleCode } from "../../../src/core/localization";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { backToFolder, openFolder, openRecent, pickFolder, scanPath, showWelcome, welcomeError } from "@/composables/actions";
import { isFallback, isWeb } from "@/lib/api";
import { localeName } from "@/lib/locales";
import { displayPath } from "@/lib/paths";
import { useDocStore } from "@/stores/doc";

const { t } = useI18n();
const store = useDocStore();
const path = ref("");
const input = ref<InstanceType<typeof Input> | null>(null);
const NONE = "__none__";
const NEW = "__new__"; // the "new language" choice
const newCode = ref("");

function submit() {
  const p = path.value.trim().replace(/^"(.*)"$/, "$1");
  if (p) scanPath(p);
}

// Step 2: the locales of the scanned folder (en is the source, not a choice).
const listing = computed(() => store.listing);
const choices = computed(() => listing.value?.locales.filter((l) => l.code !== "en") ?? []);
const target = ref("");
const reference = ref(NONE);
watch(listing, (l) => {
  if (!l) return;
  const last = store.recent.find((r) => r.path === l.path);
  const codes = choices.value.map((c) => c.code);
  target.value = last && codes.includes(last.locale) ? last.locale : codes.includes("vi") ? "vi" : (codes[0] ?? NEW);
  newCode.value = "";
  reference.value = last?.reference && codes.includes(last.reference) ? last.reference : NONE;
});
const referenceChoices = computed(() => choices.value.filter((c) => c.code !== target.value));
const code = computed(() => (target.value === NEW ? newCode.value.trim() : target.value));
const exists = computed(() => listing.value?.locales.some((l) => l.code === code.value) ?? false);
const codeOk = computed(() => code.value !== "" && code.value !== "en" && isLocaleCode(code.value));
const confirm = () => {
  if (!listing.value || !codeOk.value) return;
  openFolder(listing.value.path, code.value, reference.value === NONE ? null : reference.value, false, !exists.value);
};

onMounted(() => (input.value?.$el as HTMLInputElement | undefined)?.focus());
</script>

<template>
  <main class="flex flex-1 justify-center overflow-auto px-4 pt-[10vh] pb-6">
    <section class="bg-card flex h-fit w-full max-w-xl flex-col gap-4 rounded-xl border p-7">
      <Button v-if="store.open" variant="link" class="h-auto self-start p-0" @click="backToFolder">{{ t("welcome.back") }}</Button>

      <!-- step 2: choose the locale -->
      <template v-if="listing">
        <h1 class="text-2xl font-bold">{{ t("welcome.chooseTitle") }}</h1>
        <p class="text-muted-foreground font-mono text-xs break-all">{{ displayPath(listing.path) }}</p>
        <ul class="flex flex-col gap-1 text-[13px]" data-testid="sources">
          <li v-if="listing.resx" class="flex flex-wrap gap-x-2">
            <span class="font-semibold">{{ t("groups.source.resx") }}</span>
            <span class="text-muted-foreground font-mono text-xs leading-5">{{ listing.resx.rel || "." }}</span>
            <span class="text-muted-foreground text-xs leading-5">{{ t("welcome.resxFound", { n: listing.resx.groups.length }, listing.resx.groups.length) }}</span>
          </li>
          <li v-if="listing.items" class="flex flex-wrap gap-x-2">
            <span class="font-semibold">{{ t("groups.source.items") }}</span>
            <span class="text-muted-foreground font-mono text-xs leading-5">{{ listing.items.rel || "." }}</span>
            <span class="text-muted-foreground text-xs leading-5">
              {{ t("welcome.itemsFound", { n: listing.items.files.length, layout: t(`layout.${listing.items.layout}`) }, listing.items.files.length) }}
            </span>
          </li>
          <li v-if="!listing.resx" class="text-muted-foreground text-xs">{{ t("welcome.noResx") }}</li>
        </ul>
        <p class="text-muted-foreground">{{ t("welcome.chooseHint") }}</p>
        <form class="flex flex-col gap-4" @submit.prevent="confirm">
          <fieldset class="flex flex-col gap-1.5">
            <legend class="text-muted-foreground mb-1.5 text-xs font-semibold">{{ t("welcome.target") }}</legend>
            <label
              v-for="c in choices"
              :key="c.code"
              class="hover:bg-muted flex cursor-pointer items-center gap-3 rounded-md border px-3 py-2"
              :class="target === c.code && 'border-brand bg-brand-soft'"
              :data-testid="`locale-${c.code}`"
            >
              <input v-model="target" type="radio" name="target" :value="c.code" class="accent-(--brand)" />
              <span class="font-mono text-xs">{{ c.code }}</span>
              <span class="flex-1">{{ localeName(c.code) }}</span>
              <span class="text-muted-foreground text-xs">{{ t("welcome.groups", { n: c.groups }, c.groups) }}</span>
            </label>
            <label
              class="hover:bg-muted flex cursor-pointer flex-wrap items-center gap-3 rounded-md border border-dashed px-3 py-2"
              :class="target === NEW && 'border-brand bg-brand-soft'"
              data-testid="locale-new"
            >
              <input v-model="target" type="radio" name="target" :value="NEW" class="accent-(--brand)" />
              <span class="flex-1">{{ t("welcome.newLocale") }}</span>
              <Input
                v-if="target === NEW"
                v-model="newCode"
                class="h-8 w-28 font-mono text-xs"
                spellcheck="false"
                autocomplete="off"
                :placeholder="t('welcome.newPlaceholder')"
                :aria-invalid="newCode.trim() !== '' && !codeOk"
                data-testid="locale-new-code"
                @click.stop
              />
              <span v-if="target === NEW" class="text-muted-foreground w-full text-xs">
                {{ newCode.trim() && !codeOk ? t("welcome.newInvalid") : exists ? t("welcome.newExists") : t("welcome.newHint") }}
              </span>
            </label>
          </fieldset>
          <div v-if="referenceChoices.length" class="flex flex-col gap-1.5">
            <Label class="text-muted-foreground text-xs">{{ t("welcome.reference") }}</Label>
            <Select v-model="reference">
              <SelectTrigger class="w-60"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem :value="NONE">{{ t("welcome.referenceNone") }}</SelectItem>
                <SelectItem v-for="c in referenceChoices" :key="c.code" :value="c.code">{{ c.code }} · {{ localeName(c.code) }}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div class="flex gap-2">
            <Button type="submit" :disabled="!codeOk" data-testid="open">{{ t("welcome.openFolder") }}</Button>
            <Button type="button" variant="outline" @click="showWelcome">{{ t("welcome.otherFolder") }}</Button>
          </div>
        </form>
        <p v-if="listing.resx?.skipped.length" class="text-muted-foreground text-xs break-all">
          {{ t("welcome.skipped", { files: listing.resx.skipped.join(", ") }) }}
        </p>
      </template>

      <!-- step 1: choose the folder -->
      <template v-else>
        <h1 class="text-2xl font-bold">{{ t("welcome.title") }}</h1>
        <p class="text-muted-foreground">{{ t("welcome.hint") }}</p>
        <ul class="text-muted-foreground -mt-2 list-disc pl-5 text-[13px]" data-testid="layouts">
          <li>{{ t("welcome.kindCheckout") }} <code class="font-mono text-xs">src/Localization</code> + <code class="font-mono text-xs">src/bin/Data/Items</code></li>
          <li>{{ t("welcome.kindGame") }} <code class="font-mono text-xs">Data/Items</code>, <code class="font-mono text-xs">Main.app/Contents/MacOS/Data/Items</code></li>
          <li>{{ t("welcome.kindFolder") }}</li>
        </ul>
        <p v-if="isFallback" class="bg-muted rounded-md px-3 py-2 text-[13px]" data-testid="fallback-hint">{{ t("welcome.fallbackHint") }}</p>
        <p v-else-if="isWeb" class="text-muted-foreground text-[13px]">{{ t("welcome.webHint") }}</p>
        <Button class="self-start" data-testid="pick" @click="pickFolder()"><FolderOpen />{{ isFallback ? t("welcome.pickUpload") : t("welcome.pick") }}</Button>
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
              data-testid="path"
            />
            <Button type="submit" variant="outline">{{ t("welcome.next") }}</Button>
          </div>
        </form>
      </template>

      <p v-if="welcomeError" role="alert" class="bg-bad-soft text-destructive rounded-md px-3 py-2" data-testid="open-error">
        {{ welcomeError }}
      </p>

      <div v-if="!listing && store.recent.length">
        <h2 class="text-muted-foreground mt-2 mb-1 text-xs font-semibold">{{ t("welcome.recent") }}</h2>
        <ul class="flex flex-col gap-1 text-[13px]">
          <li v-for="r in store.recent" :key="r.path">
            <button type="button" class="text-brand text-left break-all hover:underline" data-testid="recent" @click="openRecent(r)">
              <span class="font-mono text-xs">[{{ r.locale }}{{ r.reference ? ` + ${r.reference}` : "" }}]</span> {{ displayPath(r.path) }}
            </button>
          </li>
        </ul>
      </div>
    </section>
  </main>
</template>
