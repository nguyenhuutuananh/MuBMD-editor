// dialogs.ts - Hộp thoại dạng Promise: ask() xếp hàng, <AppDialogs> hiển thị lần lượt.

import { computed, shallowRef } from "vue";

export interface DialogAction {
  id: string;
  label: string;
  kind?: "primary" | "danger";
}

export interface DialogOptions {
  title: string;
  body: string[]; // mỗi phần tử là một đoạn
  actions: DialogAction[];
  input?: { label: string; value: string; placeholder?: string; required?: boolean };
}

export interface DialogResult {
  action: string | null; // null = đóng bằng Esc / bấm ra ngoài
  value: string;
}

interface Pending extends DialogOptions {
  resolve: (r: DialogResult) => void;
}

export const dialogQueue = shallowRef<Pending[]>([]);
export const currentDialog = computed(() => dialogQueue.value[0] ?? null);
export const isDialogOpen = computed(() => dialogQueue.value.length > 0);

export function ask(opts: DialogOptions): Promise<DialogResult> {
  return new Promise((resolve) => {
    dialogQueue.value = [...dialogQueue.value, { ...opts, resolve }];
  });
}

export function resolveCurrent(result: DialogResult): void {
  const [cur, ...rest] = dialogQueue.value;
  dialogQueue.value = rest;
  cur?.resolve(result);
}
