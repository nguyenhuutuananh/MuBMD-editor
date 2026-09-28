import { describe, expect, test } from "bun:test";
import { MAX_NAME_BYTES, NAME_LEN, NameValidationError, checkName, decodeName, encodeName } from "../src/core";

describe("checkName", () => {
  test("counts UTF-8 bytes of Vietnamese text", () => {
    expect(checkName("Quyền Trượng Đại Vương").byteLength).toBe(32);
  });

  test("normalizes NFD -> NFC before counting", () => {
    const nfd = "Kiếm Rồng".normalize("NFD");
    const c = checkName(nfd);
    expect(c.normalized).toBe("Kiếm Rồng".normalize("NFC"));
    expect(c.byteLength).toBe(Buffer.byteLength("Kiếm Rồng".normalize("NFC")));
  });

  test("49 bytes is valid, 50 bytes is an error", () => {
    expect(checkName("a".repeat(MAX_NAME_BYTES)).ok).toBe(true);
    const c = checkName("a".repeat(MAX_NAME_BYTES + 1));
    expect(c.ok).toBe(false);
    expect(c.issues[0]!.code).toBe("too-long");
  });

  test("control characters are errors, extra spaces only warnings", () => {
    expect(checkName("Kiếm\tRồng").ok).toBe(false);
    expect(checkName("Kiếm\nRồng").ok).toBe(false);
    const w = checkName(" Kiếm  Rồng ");
    expect(w.ok).toBe(true);
    expect(w.issues.map((i) => i.code).sort()).toEqual(["double-space", "edge-whitespace"]);
  });

  test("a lone surrogate is an error", () => {
    expect(checkName("Ki\ud800m").ok).toBe(false);
    expect(checkName("Kiếm 🗡").ok).toBe(true);
  });
});

describe("encodeName / decodeName", () => {
  test("round-trip and 0x00 padding", () => {
    const enc = encodeName("Mũ Rồng Đỏ");
    expect(enc.length).toBe(NAME_LEN);
    expect(enc[enc.length - 1]).toBe(0);
    expect(decodeName(enc)).toEqual({ text: "Mũ Rồng Đỏ", encoding: "utf-8", byteLength: 16 });
  });

  test("an over-long name is rejected, not silently truncated", () => {
    expect(() => encodeName("Đ".repeat(25), 7)).toThrow(NameValidationError);
  });

  test("empty names and non-UTF-8 names", () => {
    expect(decodeName(new Uint8Array(NAME_LEN)).encoding).toBe("empty");
    const sjis = new Uint8Array(NAME_LEN);
    sjis.set([0x83, 0x5c, 0x81, 0x5b, 0x83, 0x68]); // "ソード" Shift_JIS
    const d = decodeName(sjis);
    expect(d.encoding).toBe("unknown");
    expect(d.byteLength).toBe(6);
  });
});
