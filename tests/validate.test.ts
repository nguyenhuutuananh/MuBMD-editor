import { describe, expect, test } from "bun:test";
import { checkValue, countBySeverity, formatArgs, parseResx, printfSpecs, scanPercent, SEVERITY, validateGroup } from "../src/core";

const codes = (en: string, value: string) => checkValue(en, value).map((i) => i.code);

describe("printf", () => {
  test("conversions reduced to the argument they consume", () => {
    expect(printfSpecs("%d %s %lu %I64d %02X %6.2f %2d %ls %S %c %hs %%")).toEqual([
      "%d",
      "%s",
      "%lu",
      "%lld",
      "%x",
      "%f",
      "%d",
      "%s",
      "%s",
      "%c",
      "%hs",
    ]);
    expect(printfSpecs("%*d %.*s %i")).toEqual(["%*d", "%*s", "%d"]);
  });

  test("plain-text percent signs", () => {
    expect(scanPercent("30% of damage, +4 %, 50%")).toEqual({ specs: [], escaped: 0, literal: 3 });
    expect(scanPercent("100%% card %#Version")).toEqual({ specs: [], escaped: 1, literal: 1 });
  });

  test("mismatch = error; order matters", () => {
    expect(codes("(%s) stat %d points", "%d pkt (%s)")).toEqual(["printf-mismatch"]);
    expect(codes("You may enter %d times", "Bạn được vào %d lần")).toEqual([]);
    expect(codes("You may enter %d times", "Bạn được vào nhiều lần")).toEqual(["printf-mismatch"]);
    expect(codes("Level %2d", "Cấp %d")).toEqual([]);
    expect(checkValue("(%s) %d", "%d (%s)")[0]!.params).toEqual({ expected: "%s %d", actual: "%d %s" });
    expect(SEVERITY["printf-mismatch"]).toBe("error");
  });

  test("en with %% is a format string: a stray conversion is an error", () => {
    expect(codes("the 100%% winning card", "die 100%-Gewinnkarte")).toEqual(["printf-mismatch"]);
    expect(codes("Sell (S)", "%s verkaufen")).toEqual(["printf-added"]);
  });

  test("percent style must follow en", () => {
    expect(codes("Increase Max HP +4%%", "Tăng HP tối đa +4%")).toEqual(["percent-style"]);
    expect(codes("EXP 10% Increase", "Tăng 10%% EXP")).toEqual(["percent-style"]);
    expect(codes("EXP 10% Increase", "Tăng 10% EXP")).toEqual([]);
  });
});

describe("I18N::Format placeholders", () => {
  test("{N}, any order, {{ is a literal", () => {
    expect(formatArgs("{1} then {0} and {1} {{2}} {x}")).toEqual([0, 1]);
    expect(codes("Index {0} is already in use", "Chỉ số {0} đã được dùng")).toEqual([]);
    expect(codes("Move {0} to {1}", "Chuyển tới {1} từ {0}")).toEqual([]);
    expect(codes("Index {0} is already in use", "Chỉ số đã được dùng")).toEqual(["format-arg-mismatch"]);
  });
});

describe("line breaks and escapes", () => {
  test("\\n written as two characters", () => {
    expect(codes("a\\nb", "x\\ny")).toEqual([]);
    expect(codes("a\\n\\nb", "x\\ny")).toEqual(["newline-mismatch"]);
  });

  test('"\\" + real line break (a translation made outside the tool) is reported once as stray, plus the count', () => {
    const issues = checkValue("30 days.\\nCan only be used", "30 ngày.\\\nChỉ có thể dùng");
    expect(issues.map((i) => i.code)).toEqual(["newline-mismatch", "stray-backslash"]);
    expect(issues[1]!.params).toEqual({ next: "newline" });
  });

  test("real line breaks", () => {
    expect(codes("one line", "hai\ndòng")).toEqual(["raw-newline"]);
    expect(codes("two\nlines", "hai\ndòng")).toEqual([]);
  });

  test("other backslashes", () => {
    expect(codes("a", "C:\\MU")).toEqual(["stray-backslash"]);
    expect(codes("a", "end\\")).toEqual(["stray-backslash"]);
    expect(checkValue("a", "end\\")[0]!.params).toEqual({ next: "end" });
  });

  test("# only counts in Item Shop messages (##)", () => {
    expect(codes("Colosseum # %d", "Đấu Trường số %d")).toEqual([]);
    expect(codes("Failed!##Please reconnect.#Version %d", "Lỗi!##Kết nối lại.#Phiên bản %d")).toEqual([]);
    expect(codes("Failed!##Please reconnect.", "Lỗi! Kết nối lại.")).toEqual(["hash-mismatch"]);
  });
});

describe("other checks", () => {
  test("empty, same as en, whitespace, NFC", () => {
    expect(codes("Event", "")).toEqual(["empty-value"]);
    expect(codes("Gulim", "Gulim")).toEqual(["same-as-en"]);
    expect(codes(" ", " ")).toEqual([]);
    expect(codes(" Title", "Tiêu đề")).toEqual(["edge-whitespace"]);
    expect(codes("Hoho", "Hoho! ")).toEqual(["edge-whitespace"]);
    expect(codes("Event", "Su\u0323 kie\u0302\u0323n")).toEqual(["not-nfc"]);
    expect(codes("Event", "Sự kiện")).toEqual([]);
  });
});

describe("validateGroup", () => {
  const EN = `<root>
  <data name="Gulim"><value>Gulim</value><comment>legacy_id=0</comment></data>
  <data name="Event"><value>Event</value><comment>legacy_id=1</comment></data>
  <data name="Level %d"><value>Level %d</value><comment>legacy_id=2</comment></data>
  <data name="몬스터"><value>몬스터</value></data>
  <data name="Event"><value>Event</value></data>
</root>`;
  const VI = `<root>
  <data name="Gulim"><value>Gulim</value></data>
  <data name="Level %d"><value>Cấp</value></data>
  <data name="몬스터"><value>Quái</value></data>
  <data name="Removed"><value>Đã xoá</value></data>
</root>`;

  test("issues and progress", () => {
    const r = validateGroup("Game", { en: parseResx(EN), vi: parseResx(VI) });
    expect(r.issues.map((i) => [i.locale, i.code, i.key ?? null, i.line ?? null])).toEqual([
      ["en", "duplicate-key", "Event", 6],
      ["en", "no-identifier", "몬스터", 5],
      ["vi", "same-as-en", "Gulim", 2],
      ["vi", "printf-mismatch", "Level %d", 3],
      ["vi", "extra-key", "Removed", 5],
    ]);
    expect(r.issues[0]!.params).toEqual({ firstLine: 3, lostLegacyIds: "1" });
    expect(r.progress.vi).toEqual({ total: 3, translated: 2, sameAsEn: 1, kept: 0, extra: 1 });
    expect(countBySeverity(r.issues)).toEqual({ error: 1, warning: 2, info: 2 });
  });

  test('"keep" in the comment: no same-as-en; keep-outdated once en changes', () => {
    const kept = VI.replace('<data name="Gulim"><value>Gulim</value></data>', '<data name="Gulim"><value>Gulim</value><comment>legacy_id=0; keep</comment></data>');
    const r = validateGroup("Game", { en: parseResx(EN), vi: parseResx(kept) });
    expect(r.issues.some((i) => i.code === "same-as-en")).toBe(false);
    expect(r.progress.vi).toMatchObject({ translated: 2, sameAsEn: 0, kept: 1 });
    const newEn = EN.replace("<value>Gulim</value>", "<value>Gulim (font)</value>");
    const r2 = validateGroup("Game", { en: parseResx(newEn), vi: parseResx(kept) });
    expect(r2.issues.filter((i) => i.key === "Gulim").map((i) => i.code)).toEqual(["keep-outdated"]);
  });

  test("no en file", () => {
    const r = validateGroup("Game", { vi: parseResx(VI) });
    expect(r.issues.map((i) => i.code)).toEqual(["missing-default"]);
    expect(r.issues[0]!.severity).toBe("error");
  });
});
