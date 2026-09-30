import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { sha1 } from "../src/core";

test("known vectors", () => {
  const enc = new TextEncoder();
  expect(sha1(enc.encode(""))).toBe("da39a3ee5e6b4b0d3255bfef95601890afd80709");
  expect(sha1(enc.encode("abc"))).toBe("a9993e364706816aba3e25717850c26c9cd0d89d");
  expect(sha1(enc.encode("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"))).toBe("84983e441c3bd26ebaae4aa1f95129e5e54670f1");
});

test("matches node:crypto around every padding boundary and at the size of a large file", () => {
  for (const n of [1, 55, 56, 57, 63, 64, 65, 119, 120, 128, 4096, 688132]) {
    const b = new Uint8Array(n).map((_, i) => (i * 131 + n) & 255);
    expect(sha1(b)).toBe(createHash("sha1").update(b).digest("hex"));
  }
});
