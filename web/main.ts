// main.ts - Giao diện: mở file, duyệt 8192 slot, sửa tên trên bảng, undo/redo, lưu.

import { MAX_ITEM_INDEX, MAX_ITEM_TYPE } from "../src/core/format";
import { MAX_NAME_BYTES, checkName } from "../src/core/nameCodec";
import {
  type DocStatus,
  type DraftInfo,
  ENCODING_LABELS,
  type FileInfo,
  ISSUE_LABELS,
  ITEM_TYPE_LABELS,
  type MutationResponse,
  type SaveRequest,
} from "../src/shared/api";
import { ApiError, api } from "./api";
import { type Filter, type Problem, type Row, type SlotScope, applyFilter, groupCounts, patchRow, toRows } from "./search";
import { showDialog, toast } from "./ui";
import { VirtualList } from "./virtualList";

const ROW_HEIGHT = 32;
const NEAR_LIMIT = 40;
const RECENT_KEY = "mubmd.recent";
const FILTER_KEY = "mubmd.filter";
const TRANSLATOR_KEY = "mubmd.translator";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const fmtTime = (iso: string) => (iso ? new Date(iso).toLocaleString("vi-VN") : "");

// ---- trạng thái ----
let file: FileInfo | null = null;
let rows: Row[] = [];
let visible: Row[] = [];
let selectedSlot: number | null = null;
let status: DocStatus = { dirtyCount: 0, canUndo: false, canRedo: false };
const filter: Filter = { group: null, scope: "named", problem: "any", query: "" };

// ---- localStorage (có thể bị chặn -> bỏ qua) ----
function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function save(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* không lưu được thì thôi */
  }
}

let translator = load<string>(TRANSLATOR_KEY, "");

// Các thao tác sửa gửi lên server lần lượt theo đúng thứ tự người dùng làm.
let chain: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.catch(() => undefined);
  return run;
}

function rememberRecent(path: string) {
  const list = [path, ...load<string[]>(RECENT_KEY, []).filter((p) => p !== path)].slice(0, 6);
  save(RECENT_KEY, list);
}

// ---- màn hình mở file ----
function showError(message: string | null) {
  const el = $("open-error");
  el.textContent = message ?? "";
  el.hidden = !message;
}

function renderRecent() {
  const list = load<string[]>(RECENT_KEY, []);
  $("recent-wrap").hidden = list.length === 0;
  $("recent").replaceChildren(
    ...list.map((p) => {
      const li = document.createElement("li");
      const b = document.createElement("button");
      b.type = "button";
      b.className = "link";
      b.textContent = p;
      b.addEventListener("click", () => openPath(p));
      li.append(b);
      return li;
    }),
  );
}

function showWelcome() {
  closeEditor();
  $("welcome").hidden = false;
  $("workspace").hidden = true;
  $("file-info").hidden = true;
  $("topbar-actions").hidden = true;
  $("btn-back").hidden = file === null;
  renderRecent();
  $("open-path").focus();
}

async function confirmDiscard(): Promise<boolean> {
  const r = await showDialog({
    title: "Bỏ thay đổi chưa lưu?",
    body: `Còn ${status.dirtyCount} thay đổi chưa lưu vào file. Nếu tiếp tục, các thay đổi này sẽ mất.`,
    actions: [
      { id: "cancel", label: "Quay lại" },
      { id: "discard", label: "Bỏ thay đổi", kind: "danger" },
    ],
  });
  return r.action === "discard";
}

async function openPath(path: string, discard = false): Promise<void> {
  showError(null);
  try {
    await api.open(path, discard);
    rememberRecent(path);
    await loadItems();
  } catch (e) {
    if (e instanceof ApiError && e.code === "dirty") {
      if (await confirmDiscard()) return openPath(path, true);
      return;
    }
    showWelcome();
    showError(errText(e));
  }
}

async function pickAndOpen() {
  showError(null);
  try {
    const { path } = await api.pick();
    if (path) await openPath(path);
  } catch (e) {
    showWelcome();
    showError(e instanceof ApiError && e.status === 501 ? e.message : `Không mở được hộp thoại: ${errText(e)}`);
  }
}

// ---- workspace ----
async function loadItems() {
  closeEditor();
  const res = await api.items();
  file = res.file;
  rows = toRows(res.items, res.edits);
  status = res.status;
  if (selectedSlot !== null && !rows[selectedSlot]) selectedSlot = null;

  $("welcome").hidden = true;
  $("workspace").hidden = false;
  $("file-info").hidden = false;
  $("topbar-actions").hidden = false;
  renderFileInfo();
  renderStatus();
  renderGroups();
  refilter();
  renderDetail();
  if (res.draft) await offerDraft(res.draft);
}

function renderFileInfo() {
  if (!file) return;
  $("file-name").textContent = file.fileName;
  // Dấu LRM giữ đường dẫn đọc trái->phải trong ô `direction: rtl` (dùng để cắt phần đầu).
  $("file-path").textContent = `‎${file.path}‎`;
  $("file-path").title = file.path;
  const badge = $("checksum-badge");
  badge.textContent = file.checksumValid ? "Checksum OK" : "Checksum sai";
  badge.className = `badge ${file.checksumValid ? "ok" : "bad"}`;
  badge.title = file.checksumValid
    ? "4 byte checksum cuối file khớp với nội dung."
    : "Checksum cuối file không khớp: file có thể bị hỏng hoặc bị sửa bằng công cụ khác. Client có thể từ chối đọc file này. Lưu lại bằng công cụ này sẽ tính lại checksum.";
}

function renderStatus() {
  const n = status.dirtyCount;
  const el = $("dirty-status");
  el.textContent = n ? `● ${n} thay đổi chưa lưu` : "Đã lưu hết";
  el.classList.toggle("dirty", n > 0);
  $<HTMLButtonElement>("btn-save").disabled = n === 0;
  $<HTMLButtonElement>("btn-undo").disabled = !status.canUndo;
  $<HTMLButtonElement>("btn-redo").disabled = !status.canRedo;
  $("btn-translator").textContent = translator ? `Người dịch: ${translator}` : "Đặt tên người dịch";
  if (file) document.title = `${n ? "• " : ""}${file.fileName} - MuBMD-editor`;
}

async function offerDraft(d: DraftInfo) {
  const who = d.translators.length ? `, người dịch: ${d.translators.join(", ")}` : "";
  const body = [
    `Lần làm việc trước (lưu nháp lúc ${fmtTime(d.savedAt)}${who}) còn ${d.count} thay đổi chưa lưu vào file.`,
    ...(d.baseMatches
      ? []
      : [
          'Lưu ý: Item.bmd trên ổ đĩa đã thay đổi kể từ lúc đó (có thể do Google Drive đồng bộ). Các tên trong nháp sẽ được áp lên file hiện tại - hãy kiểm tra lại bằng bộ lọc "Đã sửa".',
        ]),
  ].join("\n\n");
  const r = await showDialog({
    title: "Khôi phục thay đổi chưa lưu?",
    body,
    actions: [
      { id: "discard", label: "Bỏ nháp", kind: "danger" },
      { id: "restore", label: "Khôi phục", kind: "primary" },
    ],
  });
  try {
    if (r.action === "restore") {
      const res = await serial(() => api.restoreDraft());
      applyMutation(res);
      toast(`Đã khôi phục ${res.changed.length} thay đổi${res.skipped ? `, bỏ qua ${res.skipped} tên không hợp lệ` : ""}.`, "ok");
    } else if (r.action === "discard") {
      await api.discardDraft();
    }
  } catch (e) {
    toast(errText(e), "error");
  }
}

function renderGroups() {
  const counts = groupCounts(rows, MAX_ITEM_TYPE);
  const named = counts.reduce((s, c) => s + c.named, 0);
  const edited = new Array<number>(MAX_ITEM_TYPE).fill(0);
  for (const r of rows) if (r.edit) edited[r.itemType]!++;
  const make = (group: number | null, label: string, count: string, dirty: number) => {
    const li = document.createElement("li");
    const b = document.createElement("button");
    b.type = "button";
    b.className = "group";
    b.setAttribute("aria-pressed", String(filter.group === group));
    const name = document.createElement("span");
    name.className = "group-name";
    name.textContent = group === null ? label : `${group}. ${label}`;
    const c = document.createElement("span");
    c.className = "group-count";
    c.textContent = count;
    if (dirty) {
      const d = document.createElement("span");
      d.className = "group-dirty";
      d.textContent = `●${dirty} `;
      d.title = `${dirty} thay đổi chưa lưu`;
      c.prepend(d);
    }
    b.append(name, c);
    b.addEventListener("click", () => {
      filter.group = group;
      persistFilter();
      renderGroups();
      refilter();
    });
    li.append(b);
    return li;
  };
  $("groups").replaceChildren(
    make(null, "Tất cả nhóm", `${named}`, status.dirtyCount),
    ...counts.map((c, g) => make(g, ITEM_TYPE_LABELS[g] ?? `Nhóm ${g}`, `${c.named}/${MAX_ITEM_INDEX}`, edited[g]!)),
  );
}

const list = new VirtualList<Row>({
  container: $("grid-body"),
  rowHeight: ROW_HEIGHT,
  renderRow: (r, _i, el) => {
    el.classList.toggle("selected", r.slot === selectedSlot);
    el.classList.toggle("is-empty", r.encoding === "empty");
    el.classList.toggle("is-dirty", r.edit !== null);
    el.setAttribute("aria-selected", String(r.slot === selectedSlot));
    el.dataset.slot = String(r.slot);
    const flags = [
      r.edit ? "Đã sửa" : "",
      r.encoding === "unknown" ? "Không phải UTF-8" : "",
      ...r.issues.map((c) => ISSUE_LABELS[c]),
    ].filter(Boolean);
    el.innerHTML = "";
    el.append(
      cell("c-type", String(r.itemType)),
      cell("c-index", String(r.itemIndex)),
      cell("c-name", r.encoding === "empty" ? "(trống)" : r.text, r.edit ? `Tên gốc: ${r.edit.originalText || "(trống)"}` : r.text),
      bytesCell(r.byteLength),
      cell("c-flags", flags.join(" · "), flags.join("\n")),
    );
  },
});

function cell(cls: string, text: string, title?: string) {
  const s = document.createElement("span");
  s.className = cls;
  s.textContent = text;
  if (title) s.title = title;
  return s;
}

const byteLevel = (n: number) => (n > MAX_NAME_BYTES ? "over" : n >= NEAR_LIMIT ? "near" : "");

function bytesCell(n: number) {
  const s = document.createElement("span");
  s.className = `c-bytes ${byteLevel(n)}`;
  s.title = `${n}/${MAX_NAME_BYTES} byte`;
  const bar = document.createElement("span");
  bar.className = "bytes-bar";
  const fill = document.createElement("span");
  fill.style.width = `${Math.min(100, (n / MAX_NAME_BYTES) * 100)}%`;
  bar.append(fill);
  const num = document.createElement("span");
  num.className = "bytes-num";
  num.textContent = n ? String(n) : "";
  s.append(num, bar);
  return s;
}

// Lọc lại danh sách. Sau khi sửa thì KHÔNG gọi hàm này (chỉ refresh) để dòng vừa sửa không nhảy đi mất.
function refilter() {
  closeEditor();
  visible = applyFilter(rows, filter);
  list.setItems(visible);
  $("grid-empty").hidden = visible.length > 0;
  $("result-count").textContent = `${visible.length.toLocaleString("vi-VN")} dòng`;
}

const visibleIndex = (slot: number) => visible.findIndex((r) => r.slot === slot);

function select(slot: number | null, scroll = false) {
  selectedSlot = slot;
  // Chỉ đổi class, không vẽ lại nội dung dòng: vẽ lại giữa 2 lần nhấp làm trình duyệt không nhận nhấp đúp.
  for (const el of list.host.querySelectorAll<HTMLElement>(":scope > .vl-row")) {
    const on = el.dataset.slot === String(slot);
    el.classList.toggle("selected", on);
    el.setAttribute("aria-selected", String(on));
  }
  if (scroll && slot !== null) {
    const i = visibleIndex(slot);
    if (i >= 0) list.scrollIntoView(i);
  }
  renderDetail();
}

function applyMutation(res: MutationResponse) {
  for (const { item, edit } of res.changed) {
    const row = rows[item[0]];
    if (row) patchRow(row, item, edit);
  }
  status = res.status;
  renderStatus();
  renderGroups();
  list.refresh();
  renderDetail();
}

// ---- người dịch ----
async function askTranslator(): Promise<boolean> {
  const r = await showDialog({
    title: "Tên người dịch",
    body: "Tên này được ghi kèm mỗi thay đổi vào nhật ký (changes.tsv), để sau này gộp bản dịch của nhiều người biết ai sửa gì.",
    input: { label: "Tên hoặc nickname", value: translator, placeholder: "Ví dụ: Tuấn Anh", required: true },
    actions: [
      { id: "cancel", label: "Huỷ" },
      { id: "ok", label: "Lưu", kind: "primary" },
    ],
  });
  if (r.action !== "ok" || !r.value) return false;
  translator = r.value;
  save(TRANSLATOR_KEY, translator);
  renderStatus();
  return true;
}

const ensureTranslator = async () => Boolean(translator) || askTranslator();

// ---- ô sửa trên bảng ----
interface Editor {
  slot: number;
  el: HTMLDivElement;
  input: HTMLInputElement;
  counter: HTMLSpanElement;
  initial: string;
}
let editor: Editor | null = null;

function closeEditor() {
  if (!editor) return;
  editor.el.remove();
  editor = null;
  renderLiveIssues();
}

async function startEdit(slot: number) {
  if (!(await ensureTranslator())) return;
  closeEditor();
  const index = visibleIndex(slot);
  const r = rows[slot];
  if (index < 0 || !r) return;
  select(slot, true);

  const head = document.querySelector<HTMLElement>(".grid-head");
  const nameHead = head?.querySelector<HTMLElement>(".c-name");
  const bytesHead = head?.querySelector<HTMLElement>(".c-bytes");
  if (!nameHead || !bytesHead) return;

  const el = document.createElement("div");
  el.className = "inline-editor";
  el.style.top = `${list.rowTop(index)}px`;
  el.style.left = `${nameHead.offsetLeft - 6}px`;
  el.style.width = `${bytesHead.offsetLeft + bytesHead.offsetWidth - nameHead.offsetLeft + 12}px`;

  const input = document.createElement("input");
  input.type = "text";
  input.spellcheck = false;
  input.autocomplete = "off";
  input.setAttribute("aria-label", `Tên mới cho ${r.itemType}:${r.itemIndex}`);
  // Tên không phải UTF-8 hiển thị sai (U+FFFD) nên không điền sẵn để khỏi ghi rác vào file.
  const initial = r.encoding === "unknown" ? "" : r.text;
  input.value = initial;
  if (r.encoding === "unknown") input.placeholder = "Tên gốc không phải UTF-8 - gõ tên mới";

  const counter = document.createElement("span");
  counter.className = "editor-counter";
  el.append(input, counter);
  list.host.append(el);

  editor = { slot, el, input, counter, initial };
  input.addEventListener("input", updateEditor);
  input.addEventListener("keydown", onEditorKey);
  input.addEventListener("blur", () => {
    // Bấm ra ngoài: lưu nếu hợp lệ; không hợp lệ thì để nguyên ô sửa cho người dùng quay lại.
    setTimeout(() => {
      if (editor?.input === input && document.activeElement !== input && !document.querySelector("dialog[open]")) {
        commitEditor({ quiet: true });
      }
    }, 0);
  });
  input.focus();
  input.select();
  updateEditor();
}

function updateEditor() {
  if (!editor) return;
  const c = checkName(editor.input.value);
  editor.counter.textContent = `${c.byteLength}/${MAX_NAME_BYTES}`;
  editor.counter.className = `editor-counter ${byteLevel(c.byteLength)}`;
  editor.el.classList.toggle("invalid", !c.ok);
  editor.input.title = c.issues.map((i) => i.message).join("\n");
  renderLiveIssues();
}

// Trả về true nếu đã đóng ô sửa (lưu xong hoặc không có gì thay đổi).
async function commitEditor(opts: { quiet?: boolean } = {}): Promise<boolean> {
  const ed = editor;
  if (!ed) return true;
  const value = ed.input.value;
  const row = rows[ed.slot];
  if (!row) return true;
  const c = checkName(value);
  const unchanged = c.normalized === ed.initial || (row.encoding === "unknown" && value === "");
  if (unchanged) {
    closeEditor();
    return true;
  }
  if (!c.ok) {
    if (!opts.quiet) {
      toast(c.issues.find((i) => i.severity === "error")!.message, "error");
      ed.input.focus();
    }
    return false;
  }
  try {
    const res = await serial(() => api.edit(ed.slot, value, translator));
    if (editor === ed) closeEditor();
    applyMutation(res);
    return true;
  } catch (e) {
    toast(errText(e), "error");
    if (editor === ed) ed.input.focus();
    return false;
  }
}

async function moveEdit(step: number) {
  const ed = editor;
  if (!ed) return;
  const from = visibleIndex(ed.slot);
  if (!(await commitEditor())) return;
  const next = visible[from + step];
  if (next) await startEdit(next.slot);
  else $("grid-body").focus();
}

function onEditorKey(e: KeyboardEvent) {
  if (e.key === "Enter" || e.key === "Tab") {
    e.preventDefault();
    moveEdit(e.shiftKey ? -1 : 1);
  } else if (e.key === "Escape") {
    e.preventDefault();
    closeEditor();
    $("grid-body").focus();
  } else if ((e.key === "ArrowDown" || e.key === "ArrowUp") && (e.altKey || e.ctrlKey)) {
    e.preventDefault();
    moveEdit(e.key === "ArrowDown" ? 1 : -1);
  }
}

// ---- khung chi tiết ----
function renderDetail() {
  const pane = $("detail");
  const r = selectedSlot === null ? undefined : rows[selectedSlot];
  if (!r) {
    pane.innerHTML = '<p class="muted">Chọn một dòng để xem chi tiết.</p>';
    return;
  }
  const h = document.createElement("h2");
  h.className = "detail-name";
  h.textContent = r.encoding === "empty" ? "(trống)" : r.text;

  const dl = document.createElement("dl");
  const add = (k: string, v: string) => {
    const dt = document.createElement("dt");
    dt.textContent = k;
    const dd = document.createElement("dd");
    dd.textContent = v;
    dl.append(dt, dd);
  };
  if (r.edit) {
    add("Tên gốc", r.edit.originalEncoding === "unknown" ? "(không phải UTF-8)" : r.edit.originalText || "(trống)");
    add("Sửa bởi", `${r.edit.translator || "?"}${r.edit.at ? `, ${fmtTime(r.edit.at)}` : ""}`);
  }
  add("Nhóm", `${r.itemType}. ${ITEM_TYPE_LABELS[r.itemType] ?? ""}`);
  add("ItemType / Index", `${r.itemType} / ${r.itemIndex}`);
  add("Slot", `#${r.slot}`);
  add("Mã hoá", ENCODING_LABELS[r.encoding]);
  add("Độ dài", `${r.byteLength} / ${MAX_NAME_BYTES} byte, ${[...r.text].length} ký tự`);

  const msgs = [
    r.encoding === "unknown" ? "Tên không phải UTF-8 - có thể là tên gốc Nhật/Hàn chưa dịch. Giữ nguyên nếu không sửa." : "",
    ...r.issues.map((c) => ISSUE_LABELS[c]),
  ].filter(Boolean);
  const issues = document.createElement("ul");
  issues.className = "issues";
  for (const m of msgs) {
    const li = document.createElement("li");
    li.textContent = m;
    issues.append(li);
  }

  const live = document.createElement("div");
  live.id = "live-issues";

  const actions = document.createElement("div");
  actions.className = "detail-actions";
  const editBtn = document.createElement("button");
  editBtn.type = "button";
  editBtn.textContent = "Sửa tên (Enter)";
  editBtn.addEventListener("click", () => startEdit(r.slot));
  actions.append(editBtn);
  if (r.edit) {
    const revertBtn = document.createElement("button");
    revertBtn.type = "button";
    revertBtn.textContent = "Khôi phục tên gốc";
    revertBtn.addEventListener("click", () => revert(r.slot));
    actions.append(revertBtn);
  }

  const help = document.createElement("p");
  help.className = "muted small";
  help.textContent = "Enter / Tab: lưu và sang dòng dưới · Shift+Enter: lên dòng trên · Esc: huỷ · Ctrl+S: lưu file";

  pane.replaceChildren(h, dl, ...(msgs.length ? [issues] : []), live, actions, help);
  renderLiveIssues();
}

// Cảnh báo theo thời gian thực của tên đang gõ.
function renderLiveIssues() {
  const box = document.getElementById("live-issues");
  if (!box) return;
  box.replaceChildren();
  if (!editor || editor.slot !== selectedSlot) return;
  const c = checkName(editor.input.value);
  const title = document.createElement("p");
  title.className = `live-title ${byteLevel(c.byteLength)}`;
  title.textContent = `Đang sửa: ${c.byteLength}/${MAX_NAME_BYTES} byte, ${
    c.byteLength > MAX_NAME_BYTES ? `thừa ${c.byteLength - MAX_NAME_BYTES}` : `còn ${MAX_NAME_BYTES - c.byteLength}`
  } byte`;
  box.append(title);
  if (c.issues.length) {
    const ul = document.createElement("ul");
    ul.className = "issues live";
    for (const i of c.issues) {
      const li = document.createElement("li");
      li.textContent = i.message;
      li.className = i.severity;
      ul.append(li);
    }
    box.append(ul);
  }
}

// ---- thao tác ----
async function revert(slot: number) {
  closeEditor();
  try {
    applyMutation(await serial(() => api.revert(slot, translator)));
  } catch (e) {
    toast(errText(e), "error");
  }
}

async function undoRedo(which: "undo" | "redo") {
  if (!(await commitEditor())) return;
  try {
    const res = await serial(() => (which === "undo" ? api.undo() : api.redo()));
    applyMutation(res);
    const first = res.changed[0]?.item[0];
    if (first !== undefined && visibleIndex(first) >= 0) select(first, true);
  } catch (e) {
    toast(errText(e), "error");
  }
}

async function saveFile(opts: SaveRequest = {}) {
  if (!(await commitEditor())) return;
  try {
    const res = await serial(() => api.save(opts));
    await loadItems();
    const where = res.backupPath ? ` Bản cũ đã được backup vào ${res.backupPath}` : "";
    toast(
      res.savedCount ? `Đã lưu ${res.savedCount} thay đổi vào ${res.file.fileName}.${where}` : "Không có thay đổi nào cần lưu.",
      "ok",
      8000,
    );
  } catch (e) {
    if (e instanceof ApiError && e.code === "conflict") return resolveConflict(e.message);
    toast(`Chưa lưu được: ${errText(e)}`, "error", 10000);
  }
}

async function resolveConflict(message: string) {
  const r = await showDialog({
    title: "File đã bị thay đổi bên ngoài",
    body: `${message}\n\nBạn có thể lưu thành file khác để không đè lên, hoặc ghi đè (bản trên đĩa vẫn được backup trước khi ghi).`,
    actions: [
      { id: "cancel", label: "Huỷ" },
      { id: "force", label: "Ghi đè", kind: "danger" },
      { id: "save-as", label: "Lưu thành file khác…", kind: "primary" },
    ],
  });
  if (r.action === "force") await saveFile({ force: true });
  else if (r.action === "save-as") await saveAs();
}

async function saveAs() {
  if (!(await commitEditor())) return;
  try {
    const { path } = await api.pickSave();
    if (path) await saveFile({ path });
  } catch (e) {
    toast(errText(e), "error");
  }
}

function persistFilter() {
  save(FILTER_KEY, { group: filter.group, scope: filter.scope, problem: filter.problem });
}

const inTextField = (el: Element | null) => el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;

// ---- sự kiện ----
function bind() {
  $("btn-pick").addEventListener("click", pickAndOpen);
  $("btn-open-other").addEventListener("click", showWelcome);
  $("btn-back").addEventListener("click", () => {
    showError(null);
    loadItems();
  });
  $("btn-reload").addEventListener("click", () => file && openPath(file.path));
  $("btn-save").addEventListener("click", () => saveFile());
  $("btn-save-as").addEventListener("click", saveAs);
  $("btn-undo").addEventListener("click", () => undoRedo("undo"));
  $("btn-redo").addEventListener("click", () => undoRedo("redo"));
  $("btn-translator").addEventListener("click", askTranslator);
  $("open-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const p = $<HTMLInputElement>("open-path").value.trim().replace(/^"(.*)"$/, "$1");
    if (p) openPath(p);
  });

  const search = $<HTMLInputElement>("search");
  let t = 0;
  const applySearch = () => {
    clearTimeout(t);
    if (filter.query === search.value) return;
    filter.query = search.value;
    refilter();
  };
  search.addEventListener("input", () => {
    clearTimeout(t);
    t = window.setTimeout(applySearch, 80);
  });
  // Enter / ↓ trong ô tìm: nhảy xuống dòng đầu tiên của kết quả.
  search.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== "ArrowDown") return;
    e.preventDefault();
    applySearch();
    if (visible[0]) select(visible[0].slot, true);
    $("grid-body").focus();
  });

  const scope = $<HTMLSelectElement>("scope");
  const problem = $<HTMLSelectElement>("problem");
  scope.value = filter.scope;
  problem.value = filter.problem;
  scope.addEventListener("change", () => {
    filter.scope = scope.value as SlotScope;
    persistFilter();
    refilter();
  });
  problem.addEventListener("change", () => {
    filter.problem = problem.value as Problem;
    persistFilter();
    refilter();
  });

  const body = $("grid-body");
  const rowSlot = (target: EventTarget | null) => {
    const el = (target as HTMLElement).closest<HTMLElement>(".vl-spacer > .vl-row");
    return el?.dataset.slot ? Number(el.dataset.slot) : null;
  };
  body.addEventListener("click", (e) => {
    if ((e.target as HTMLElement).closest(".inline-editor")) return;
    const slot = rowSlot(e.target);
    if (slot !== null) select(slot);
    body.focus();
  });
  body.addEventListener("dblclick", (e) => {
    const slot = rowSlot(e.target);
    if (slot !== null) startEdit(slot);
  });
  body.addEventListener("keydown", (e) => {
    if (e.target !== body || !visible.length) return;
    if ((e.key === "Enter" || e.key === "F2") && selectedSlot !== null) {
      e.preventDefault();
      startEdit(selectedSlot);
      return;
    }
    const cur = selectedSlot === null ? -1 : visibleIndex(selectedSlot);
    const step: Record<string, number> = { ArrowDown: 1, ArrowUp: -1, PageDown: list.pageSize, PageUp: -list.pageSize };
    let next: number | null = null;
    if (e.key in step) next = cur < 0 ? 0 : cur + step[e.key]!;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = visible.length - 1;
    if (next === null) return;
    e.preventDefault();
    next = Math.max(0, Math.min(visible.length - 1, next));
    select(visible[next]!.slot, true);
  });

  document.addEventListener("keydown", (e) => {
    if ($("workspace").hidden || document.querySelector("dialog[open]")) return;
    if (!(e.ctrlKey || e.metaKey)) return;
    const key = e.key.toLowerCase();
    if (key === "s") {
      e.preventDefault();
      if (e.shiftKey) saveAs();
      else saveFile();
    } else if (key === "f") {
      e.preventDefault();
      search.focus();
      search.select();
    } else if (!inTextField(document.activeElement) && (key === "z" || key === "y")) {
      // Trong ô nhập thì để trình duyệt tự undo chữ đang gõ.
      e.preventDefault();
      undoRedo(key === "y" || e.shiftKey ? "redo" : "undo");
    }
  });
}

async function start() {
  Object.assign(filter, load<Partial<Filter>>(FILTER_KEY, {}), { query: "" });
  bind();
  try {
    const state = await api.state();
    if (state.file) await loadItems();
    else showWelcome();
  } catch (e) {
    showWelcome();
    showError(errText(e));
  }
}

start();
