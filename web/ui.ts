// ui.ts - Hộp thoại và thông báo nhỏ dùng chung.

export interface DialogAction {
  id: string;
  label: string;
  kind?: "primary" | "danger";
}

export interface DialogOptions {
  title: string;
  body: string | Node[];
  actions: DialogAction[];
  input?: { label: string; value: string; placeholder?: string; required?: boolean };
}

export interface DialogResult {
  action: string | null; // null = đóng bằng Esc
  value: string;
}

// Hộp thoại modal (thẻ <dialog>). Nút đầu tiên kiểu primary nhận Enter.
export function showDialog(opts: DialogOptions): Promise<DialogResult> {
  return new Promise((resolve) => {
    const dlg = document.createElement("dialog");
    dlg.className = "dialog";
    const form = document.createElement("form");
    form.method = "dialog";

    const h = document.createElement("h2");
    h.textContent = opts.title;
    form.append(h);

    const body = document.createElement("div");
    body.className = "dialog-body";
    if (typeof opts.body === "string") {
      for (const para of opts.body.split("\n\n")) {
        const p = document.createElement("p");
        p.textContent = para;
        body.append(p);
      }
    } else body.append(...opts.body);
    form.append(body);

    let input: HTMLInputElement | null = null;
    if (opts.input) {
      const label = document.createElement("label");
      label.className = "dialog-input";
      label.textContent = opts.input.label;
      input = document.createElement("input");
      input.type = "text";
      input.value = opts.input.value;
      input.placeholder = opts.input.placeholder ?? "";
      input.required = opts.input.required ?? false;
      input.autocomplete = "off";
      label.append(input);
      form.append(label);
    }

    const actions = document.createElement("div");
    actions.className = "dialog-actions";
    for (const a of opts.actions) {
      const b = document.createElement("button");
      b.type = "submit";
      b.value = a.id;
      b.textContent = a.label;
      if (a.kind) b.className = a.kind;
      actions.append(b);
    }
    form.append(actions);
    dlg.append(form);

    // Enter trong ô nhập: trình duyệt mặc định bấm nút submit ĐẦU TIÊN (thường là "Huỷ") - ép về nút chính.
    const primary = actions.querySelector<HTMLButtonElement>(".primary");
    input?.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.isComposing && primary) {
        e.preventDefault();
        form.requestSubmit(primary);
      }
    });
    document.body.append(dlg);

    let action: string | null = null;
    form.addEventListener("submit", (e) => {
      const submitter = (e as SubmitEvent).submitter as HTMLButtonElement | null;
      action = submitter?.value ?? opts.actions.find((a) => a.kind === "primary")?.id ?? null;
      if (input?.required && action !== "cancel" && !input.value.trim()) {
        e.preventDefault();
        input.focus();
      }
    });
    dlg.addEventListener("close", () => {
      resolve({ action, value: input?.value.trim() ?? "" });
      dlg.remove();
    });
    dlg.showModal();
    (input ?? actions.querySelector<HTMLButtonElement>(".primary") ?? actions.querySelector("button"))?.focus();
  });
}

let toastHost: HTMLElement | null = null;

export function toast(message: string, kind: "info" | "ok" | "error" = "info", ms = 5000) {
  if (!toastHost) {
    toastHost = document.createElement("div");
    toastHost.className = "toasts";
    toastHost.setAttribute("aria-live", "polite");
    document.body.append(toastHost);
  }
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = message;
  el.addEventListener("click", () => el.remove());
  toastHost.append(el);
  setTimeout(() => el.remove(), ms);
}
