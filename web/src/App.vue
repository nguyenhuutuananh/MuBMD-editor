<script setup lang="ts">
import { usePreferredDark } from "@vueuse/core";
import { onBeforeUnmount, onMounted, ref, watchEffect } from "vue";
import "vue-sonner/style.css";
import AppDialogs from "@/components/AppDialogs.vue";
import AppTopbar from "@/components/AppTopbar.vue";
import DetailPanel from "@/components/DetailPanel.vue";
import GroupSidebar from "@/components/GroupSidebar.vue";
import ItemGrid from "@/components/ItemGrid.vue";
import ItemToolbar from "@/components/ItemToolbar.vue";
import WelcomeScreen from "@/components/WelcomeScreen.vue";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { onGlobalKeydown, start } from "@/composables/actions";
import { useDocStore } from "@/stores/doc";

const store = useDocStore();
const toolbar = ref<InstanceType<typeof ItemToolbar> | null>(null);

// Sáng/tối theo cài đặt hệ điều hành.
const dark = usePreferredDark();
watchEffect(() => document.documentElement.classList.toggle("dark", dark.value));

const onKey = (e: KeyboardEvent) => onGlobalKeydown(e, () => toolbar.value?.focusSearch());
onMounted(() => {
  window.addEventListener("keydown", onKey);
  start();
});
onBeforeUnmount(() => window.removeEventListener("keydown", onKey));
</script>

<template>
  <TooltipProvider :delay-duration="400">
    <div class="flex h-full flex-col">
      <AppTopbar />
      <WelcomeScreen v-if="store.view === 'welcome'" />
      <div
        v-else
        class="grid min-h-0 flex-1 grid-cols-1 grid-rows-[auto_minmax(0,1fr)] md:grid-cols-[220px_minmax(0,1fr)] md:grid-rows-1 xl:grid-cols-[240px_minmax(0,1fr)_300px]"
      >
        <GroupSidebar />
        <section class="flex min-h-0 min-w-0 flex-col">
          <ItemToolbar ref="toolbar" />
          <ItemGrid />
        </section>
        <DetailPanel class="hidden xl:block" />
      </div>
    </div>
    <AppDialogs />
    <Toaster rich-colors close-button position="bottom-right" :theme="dark ? 'dark' : 'light'" />
  </TooltipProvider>
</template>
