import { describe, expect, test } from "bun:test";
import { MAX_NAME_BYTES, NAME_LEN, NameValidationError, checkName, decodeName, encodeName } from "../src/core";

describe("checkName", () => {
  test("đếm byte UTF-8 của tiếng Việt", () => {
    expect(checkName("Quyền Trượng Đại Vương").byteLength).toBe(32);
  });

  test("chuẩn hoá NFD -> NFC trước khi đếm", () => {
    const nfd = "Kiếm Rồng".normalize("NFD");
    const c = checkName(nfd);
    expect(c.normalized).toBe("Kiếm Rồng".normalize("NFC"));
    expect(c.byteLength).toBe(Buffer.byteLength("Kiếm Rồng".normalize("NFC")));
  });

  test("49 byte hợp lệ, 50 byte là lỗi", () => {
    expect(checkName("a".repeat(MAX_NAME_BYTES)).ok).toBe(true);
    const c = checkName("a".repeat(MAX_NAME_BYTES + 1));
    expect(c.ok).toBe(false);
    expect(c.issues[0]!.code).toBe("too-long");
  });

  test("ký tự điều khiển là lỗi, khoảng trắng thừa chỉ là cảnh báo", () => {
    expect(checkName("Kiếm\tRồng").ok).toBe(false);
    expect(checkName("Kiếm\nRồng").ok).toBe(false);
    const w = checkName(" Kiếm  Rồng ");
    expect(w.ok).toBe(true);
    expect(w.issues.map((i) => i.code).sort()).toEqual(["double-space", "edge-whitespace"]);
  });

  test("surrogate lẻ là lỗi", () => {
    expect(checkName("Ki\ud800m").ok).toBe(false);
    expect(checkName("Kiếm 🗡").ok).toBe(true);
  });
});

describe("encodeName / decodeName", () => {
  test("round-trip và điền 0x00", () => {
    const enc = encodeName("Mũ Rồng Đỏ");
    expect(enc.length).toBe(NAME_LEN);
    expect(enc[enc.length - 1]).toBe(0);
    expect(decodeName(enc)).toEqual({ text: "Mũ Rồng Đỏ", encoding: "utf-8", byteLength: 16 });
  });

  test("tên quá dài bị từ chối, không cắt ngầm", () => {
    expect(() => encodeName("Đ".repeat(25), 7)).toThrow(NameValidationError);
  });

  test("tên rỗng và tên không phải UTF-8", () => {
    expect(decodeName(new Uint8Array(NAME_LEN)).encoding).toBe("empty");
    const sjis = new Uint8Array(NAME_LEN);
    sjis.set([0x83, 0x5c, 0x81, 0x5b, 0x83, 0x68]); // "ソード" Shift_JIS
    const d = decodeName(sjis);
    expect(d.encoding).toBe("unknown");
    expect(d.byteLength).toBe(6);
  });
});
