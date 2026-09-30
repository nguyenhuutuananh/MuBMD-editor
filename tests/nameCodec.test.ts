import { describe, expect, test } from "bun:test";
import { MAX_NAME_CHARS, checkName, nameLength } from "../src/core";

describe("checkName", () => {
  test("counts characters like the game (UTF-16 units), not bytes", () => {
    expect(checkName("Quyền Trượng Đại Vương").length).toBe(22);
    expect(nameLength("Kiếm 🗡")).toBe(7); // an emoji is 2 wchar_t on Windows
  });

  test("normalizes NFD -> NFC before counting", () => {
    const nfd = "Kiếm Rồng".normalize("NFD");
    const c = checkName(nfd);
    expect(c.normalized).toBe("Kiếm Rồng".normalize("NFC"));
    expect(c.length).toBe(9);
  });

  test("49 characters is valid, 50 is an error", () => {
    expect(checkName("Đ".repeat(MAX_NAME_CHARS)).ok).toBe(true);
    const c = checkName("Đ".repeat(MAX_NAME_CHARS + 1));
    expect(c.ok).toBe(false);
    expect(c.issues[0]).toMatchObject({ code: "too-long", params: { chars: 50, max: 49 } });
  });

  test("control characters and the \"||\" separator are errors, extra spaces only warnings", () => {
    expect(checkName("Kiếm\tRồng").ok).toBe(false);
    expect(checkName("Kiếm\nRồng").ok).toBe(false);
    expect(checkName("Kiếm||Rồng").issues.map((i) => i.code)).toEqual(["separator"]);
    expect(checkName("Kiếm | Rồng").ok).toBe(true);
    const w = checkName(" Kiếm  Rồng ");
    expect(w.ok).toBe(true);
    expect(w.issues.map((i) => i.code).sort()).toEqual(["double-space", "edge-whitespace"]);
  });

  test("a lone surrogate is an error", () => {
    expect(checkName("Ki\ud800m").ok).toBe(false);
    expect(checkName("Kiếm 🗡").ok).toBe(true);
  });

  test("an empty name is valid (= not translated)", () => {
    expect(checkName("")).toMatchObject({ ok: true, length: 0, issues: [] });
  });
});
