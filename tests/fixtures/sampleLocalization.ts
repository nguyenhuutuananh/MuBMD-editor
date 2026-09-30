// A small Localization folder (made-up texts in MuMain's layouts) for `bun run dev` and the
// session / server tests. It contains one of each problem the validator knows, on purpose.

import * as fs from "node:fs";
import * as path from "node:path";

const HEADER = `<?xml version="1.0" encoding="utf-8"?>
<root>
  <resheader name="resmimetype"><value>text/microsoft-resx</value></resheader>
  <resheader name="version"><value>2.0</value></resheader>
`;

type Entry = [key: string, value: string, comment?: string];

export function resxText(entries: Entry[]): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const attr = (s: string) => esc(s).replace(/"/g, "&quot;");
  const body = entries
    .map(
      ([k, v, c]) =>
        `  <data name="${attr(k)}" xml:space="preserve">\n    <value>${esc(v)}</value>\n` +
        (c ? `    <comment>${esc(c)}</comment>\n` : "") +
        "  </data>\n",
    )
    .join("");
  return `${HEADER}${body}</root>\n`;
}

const GAME_EN: Entry[] = [
  ["Gulim", "Gulim", "legacy_id=0,18"],
  ["You have been disconnected from the server.", "You have been disconnected from the server.", "legacy_id=3"],
  ["Warning", "Warning!!! Continued attempts at hacking will result in a permanent account(%s) ban!!", "legacy_id=1"],
  ["(%s) stat %d points have been generated.", "(%s) stat %d points have been generated.", "legacy_id=4"],
  ["ItemShop30Days", "An item that lets you enjoy MU for 30 days.\\nCan only be used from the MU Online website.", "legacy_id=5"],
  ["Increase Max HP +4%%", "Increase Max HP +4%%", "legacy_id=6"],
  ["Event", "Event", "legacy_id=7"],
  ["Connecting to the server", "Connecting to the server", "legacy_id=8"],
  ["몬스터", "몬스터", "legacy_id=9"],
  ["Shop failed", "MU Item Shop information download failed!##Please reconnect to the game.", "legacy_id=10"],
  ["Level %d", "Level %d", "legacy_id=11"],
  ["Chaos Castle", "Chaos Castle", "legacy_id=12"],
];

const GAME_VI: Entry[] = [
  ["Gulim", "Gulim"],
  ["You have been disconnected from the server.", "Bạn đã bị ngắt kết nối khỏi máy chủ."],
  ["Warning", "Cảnh báo!!! Tiếp tục cố gắng hack sẽ dẫn đến khóa vĩnh viễn tài khoản(%s)!!"],
  ["(%s) stat %d points have been generated.", "Đã tạo %d điểm chỉ số (%s)."], // order swapped
  ["ItemShop30Days", "Vật phẩm cho phép bạn chơi MU trong 30 ngày.\\\nChỉ có thể dùng từ trang web MU Online."],
  ["Increase Max HP +4%%", "Tăng HP tối đa +4%"],
  ["Event", "Sự kiện"],
  ["몬스터", "Quái vật"],
  ["Shop failed", "Tải thông tin Item Shop thất bại!##Vui lòng kết nối lại."],
  ["Removed key", "Khoá đã bị xoá khỏi en"],
];

const GAME_DE: Entry[] = [
  ["You have been disconnected from the server.", "Die Verbindung zum Server wurde getrennt."],
  ["Event", "Ereignis"],
  ["Level %d", "Stufe %d"],
];

const EDITOR_EN: Entry[] = [
  ["Save Items", "Save Items"],
  ["Index {0} is already in use", "Index {0} is already in use"],
  ["Export as CSV", "Export as CSV"],
];

const EDITOR_VI: Entry[] = [
  ["Save Items", "Lưu vật phẩm"],
  ["Index {0} is already in use", "Chỉ số đã được dùng"],
];

const DIALOG_EN: Entry[] = [
  ["Text_0", "Aye! Is there anything you need?", "legacy_id=0"],
  ["Text_1", "Hello! My name is Baz and I am the vault keeper.", "legacy_id=1"],
];

export const SAMPLE_FILES: Record<string, string> = {
  "Game.en.resx": resxText(GAME_EN),
  "Game.vi.resx": resxText(GAME_VI),
  "Game.de.resx": resxText(GAME_DE),
  "Editor.en.resx": resxText(EDITOR_EN),
  "Editor.vi.resx": resxText(EDITOR_VI),
  "Dialog.en.resx": resxText(DIALOG_EN), // no Dialog.vi.resx yet
  "Game.vi.resx.bak": resxText(GAME_VI.slice(0, 2)),
};

export function writeSampleLocalization(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(SAMPLE_FILES)) fs.writeFileSync(path.join(dir, name), text);
}

export function sampleBytes(): Record<string, Uint8Array> {
  return Object.fromEntries(Object.entries(SAMPLE_FILES).map(([n, t]) => [n, new TextEncoder().encode(t)]));
}
