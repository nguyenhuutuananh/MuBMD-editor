<script setup lang="ts">
import { nextTick, ref, watch } from "vue";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { currentDialog, resolveCurrent } from "@/lib/dialogs";

const value = ref("");
const content = ref<HTMLElement | null>(null);

watch(currentDialog, (d) => {
  value.value = d?.input?.value ?? "";
});

function choose(id: string) {
  const d = currentDialog.value;
  if (!d) return;
  if (d.input?.required && id !== "cancel" && !value.value.trim()) {
    focusFirst();
    return;
  }
  resolveCurrent({ action: id, value: value.value.trim() });
}

// Enter trong ô nhập luôn chọn nút chính (không phải nút đầu tiên như form mặc định).
function onInputEnter(e: KeyboardEvent) {
  if (e.isComposing || e.keyCode === 229) return;
  e.preventDefault();
  const primary = currentDialog.value?.actions.find((a) => a.kind === "primary");
  if (primary) choose(primary.id);
}

function onOpenChange(open: boolean) {
  if (!open && currentDialog.value) resolveCurrent({ action: null, value: "" });
}

// Mở hộp thoại: focus ô nhập, nếu không có thì nút chính.
function focusFirst() {
  nextTick(() => {
    const root = document.querySelector<HTMLElement>("[data-slot=dialog-content]");
    (root?.querySelector<HTMLElement>("input") ?? root?.querySelector<HTMLElement>("[data-primary]"))?.focus();
  });
}
</script>

<template>
  <Dialog :open="currentDialog !== null" @update:open="onOpenChange">
    <DialogContent
      v-if="currentDialog"
      ref="content"
      :show-close-button="false"
      class="sm:max-w-lg"
      data-testid="dialog"
      @open-auto-focus.prevent="focusFirst"
    >
      <DialogHeader>
        <DialogTitle>{{ currentDialog.title }}</DialogTitle>
        <DialogDescription as="div" class="flex flex-col gap-2.5 text-left leading-relaxed break-words">
          <p v-for="(p, i) in currentDialog.body" :key="i">{{ p }}</p>
        </DialogDescription>
      </DialogHeader>
      <div v-if="currentDialog.input" class="flex flex-col gap-1.5">
        <Label for="dialog-input" class="text-muted-foreground text-xs">{{ currentDialog.input.label }}</Label>
        <Input
          id="dialog-input"
          v-model="value"
          autocomplete="off"
          :placeholder="currentDialog.input.placeholder"
          @keydown.enter="onInputEnter"
        />
      </div>
      <DialogFooter class="flex-wrap gap-2">
        <Button
          v-for="a in currentDialog.actions"
          :key="a.id"
          :variant="a.kind === 'primary' ? 'default' : 'outline'"
          :class="a.kind === 'danger' ? 'border-destructive text-destructive hover:bg-bad-soft hover:text-destructive' : ''"
          :data-primary="a.kind === 'primary' ? '' : undefined"
          :data-testid="`dialog-${a.id}`"
          @click="choose(a.id)"
        >
          {{ a.label }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
