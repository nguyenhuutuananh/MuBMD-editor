<script setup lang="ts">
// The locale is not in the game's hand-written language lists: show where to add which line.
// The tool never edits those files itself.
import { Copy } from "@lucide/vue";
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import type { RegistrationFile } from "../../../src/shared/api";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { registrationOpen } from "@/composables/actions";
import { toast } from "vue-sonner";
import { tr } from "@/i18n";
import { useDocStore } from "@/stores/doc";

const { t } = useI18n();
const store = useDocStore();
const reg = computed(() => store.registration);

const files = computed(() => {
  const r = reg.value;
  if (!r) return [];
  const list: { key: "optionWindow" | "emitter"; file: RegistrationFile }[] = [];
  if (r.optionWindow) list.push({ key: "optionWindow", file: r.optionWindow });
  if (r.emitter) list.push({ key: "emitter", file: r.emitter });
  return list;
});

async function copy(line: string) {
  try {
    await navigator.clipboard.writeText(line.trim());
    toast.success(tr("registration.copied"));
  } catch {
    toast.error(tr("registration.copyFailed"));
  }
}
</script>

<template>
  <Dialog :open="registrationOpen" @update:open="(o) => (registrationOpen = o)">
    <DialogContent v-if="reg" class="sm:max-w-2xl" data-testid="registration-dialog">
      <DialogHeader>
        <DialogTitle>{{ t("registration.title", { locale: reg.locale }) }}</DialogTitle>
        <DialogDescription>{{ t("registration.body", { locale: reg.locale }) }}</DialogDescription>
      </DialogHeader>
      <div class="flex flex-col gap-4 text-[13px]">
        <section v-for="f in files" :key="f.key" class="flex flex-col gap-1.5">
          <h3 class="font-semibold">{{ t(`registration.${f.key}`) }}</h3>
          <p class="text-muted-foreground font-mono text-xs break-all">{{ f.file.path }}</p>
          <p v-if="f.file.registered" class="text-ok">{{ t("registration.ok", { locale: reg.locale }) }}</p>
          <template v-else>
            <p>{{ f.file.after ? t("registration.addAfter", { after: f.file.after }) : t("registration.addFirst") }}</p>
            <div class="bg-muted flex items-center gap-2 rounded-md px-2.5 py-2">
              <code class="min-w-0 flex-1 overflow-x-auto font-mono text-xs whitespace-pre" :data-testid="`registration-line-${f.key}`">{{ f.file.line }}</code>
              <Button variant="outline" size="icon-sm" :aria-label="t('registration.copy')" @click="copy(f.file.line)"><Copy /></Button>
            </div>
          </template>
        </section>
        <p v-if="reg.name === reg.locale" class="text-warn">{{ t("registration.unknownName", { locale: reg.locale }) }}</p>
        <p class="text-muted-foreground">{{ t("registration.rebuild") }}</p>
      </div>
      <DialogFooter>
        <Button @click="registrationOpen = false">{{ t("common.close") }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
