// tabs.ts - Notice when the same folder is open in another tab of this browser (web build): each
// tab keeps its own copy in memory, so saving in both would overwrite one with the other.

const channel = typeof BroadcastChannel === "function" ? new BroadcastChannel("mumain-translator-tabs") : null;
const tabId = Math.random().toString(36).slice(2);
let current: string | null = null;
let onConflict: (() => void) | null = null;

type Msg = { type: "opened" | "also-open"; path: string; from: string };

channel?.addEventListener("message", (e: MessageEvent<Msg>) => {
  const m = e.data;
  if (!current || m.from === tabId || m.path !== current) return;
  if (m.type === "opened") channel.postMessage({ type: "also-open", path: current, from: tabId } satisfies Msg);
  onConflict?.();
});

// Call after opening a folder; `warn` runs (in both tabs) if another tab has the same one open.
export function announceOpen(path: string, warn: () => void) {
  current = path;
  onConflict = warn;
  channel?.postMessage({ type: "opened", path, from: tabId } satisfies Msg);
}
