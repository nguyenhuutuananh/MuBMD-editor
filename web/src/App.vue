<script setup lang="ts">
import { usePreferredDark } from "@vueuse/core";
import { onBeforeUnmount, onMounted, watchEffect } from "vue";
import "vue-sonner/style.css";
import AppDialogs from "@/components/AppDialogs.vue";
import AppTopbar from "@/components/AppTopbar.vue";
import DetailPanel from "@/components/DetailPanel.vue";
import ExportDialog from "@/components/ExportDialog.vue";
import GlossaryDialog from "@/components/GlossaryDialog.vue";
import ImportDialog from "@/components/ImportDialog.vue";
import RegistrationDialog from "@/components/RegistrationDialog.vue";
import GroupSidebar from "@/components/GroupSidebar.vue";
import RowGrid from "@/components/RowGrid.vue";
import RowToolbar from "@/components/RowToolbar.vue";
import WelcomeScreen from "@/components/WelcomeScreen.vue";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { onGlobalKeydown, reloadProposals, start } from "@/composables/actions";
import { useDocStore } from "@/stores/doc";

const store = useDocStore();

// Light/dark follows the OS setting.
const dark = usePreferredDark();
watchEffect(() => document.documentElement.classList.toggle("dark", dark.value));

// Unsaved edits are kept in the draft anyway, but closing the tab should not be silent.
const onBeforeUnload = (e: BeforeUnloadEvent) => {
  if (!store.status.dirtyCount) return;
  e.preventDefault();
  e.returnValue = "";
};
// Back from the terminal where the AI assistant wrote proposals: read them again.
const onFocus = () => reloadProposals(true);
onMounted(() => {
  window.addEventListener("keydown", onGlobalKeydown);
  window.addEventListener("focus", onFocus);
  window.addEventListener("beforeunload", onBeforeUnload);
  start();
});
onBeforeUnmount(() => {
  window.removeEventListener("keydown", onGlobalKeydown);
  window.removeEventListener("focus", onFocus);
  window.removeEventListener("beforeunload", onBeforeUnload);
});
</script>

<template>
  <TooltipProvider :delay-duration="400">
    <div class="flex h-full flex-col">
      <AppTopbar />
      <WelcomeScreen v-if="store.view === 'welcome'" />
      <div
        v-else
        class="grid min-h-0 flex-1 grid-cols-1 grid-rows-[auto_minmax(0,1fr)] md:grid-cols-[260px_minmax(0,1fr)] md:grid-rows-1 xl:grid-cols-[270px_minmax(0,1fr)_360px]"
      >
        <GroupSidebar />
        <section class="flex min-h-0 min-w-0 flex-col">
          <RowToolbar />
          <RowGrid />
        </section>
        <DetailPanel class="hidden xl:block" />
      </div>
    </div>
    <AppDialogs />
    <ExportDialog />
    <ImportDialog />
    <GlossaryDialog />
    <RegistrationDialog />
    <Toaster rich-colors close-button position="bottom-right" :theme="dark ? 'dark' : 'light'" />
  </TooltipProvider>
</template>
