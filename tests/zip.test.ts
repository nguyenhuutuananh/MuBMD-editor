// ZIP: the writer, the reader (stored and deflate) and the inflate decoder against node:zlib.
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { deflateRawSync } from "node:zlib";
import { AppError, inflateRaw, isZip, unzip, zip } from "../src/core";

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

function pseudoRandom(n: number, seed: number, alphabet = 256): Uint8Array {
  const out = new Uint8Array(n);
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    out[i] = (x >>> 16) % alphabet;
  }
  return out;
}

describe("inflate", () => {
  const samples: [string, Uint8Array][] = [
    ["empty", new Uint8Array(0)],
    ["short text", enc("Mũ Rồng")],
    ["repetitive text", enc("Ngọc Ước Nguyện, Ngọc Tâm Linh. ".repeat(2000))],
    ["random bytes", pseudoRandom(70000, 1)],
    ["small alphabet", pseudoRandom(200000, 7, 4)],
    ["resx-like", enc(Array.from({ length: 3000 }, (_, i) => `  <data name="Key ${i}" xml:space="preserve">\n    <value>Giá trị ${i * 7}</value>\n  </data>\n`).join(""))],
  ];
  for (const [name, data] of samples) {
    test(name, () => {
      for (const level of [0, 1, 6, 9]) {
        const packed = new Uint8Array(deflateRawSync(data, { level }));
        expect(inflateRaw(packed, data.length)).toEqual(data);
        expect(inflateRaw(packed)).toEqual(data); // without a size hint
      }
    });
  }
  test("broken data is an error", () => {
    expect(() => inflateRaw(new Uint8Array(deflateRawSync(enc("hello world")).subarray(0, 3)))).toThrow(AppError);
  });
});

describe("zip / unzip", () => {
  test("round trip with folders and UTF-8 names", () => {
    const files = [
      { name: "manifest.json", bytes: enc("{}") },
      { name: "files/src/Localization/Game.vi.resx", bytes: enc("<root>Sự kiện</root>") },
      { name: "ghi chú.txt", bytes: new Uint8Array(0) },
    ];
    const z = zip(files);
    expect(isZip(z)).toBe(true);
    expect(unzip(z)).toEqual(files);
  });

  test("an archive made by the zip command (deflate, folder entries)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mumain-zip-"));
    fs.mkdirSync(path.join(dir, "pkg", "files"), { recursive: true });
    const text = "Giày Rồng Đỏ\t".repeat(500);
    fs.writeFileSync(path.join(dir, "pkg", "translations.tsv"), text);
    fs.writeFileSync(path.join(dir, "pkg", "files", "a.json"), '{"a":1}');
    execFileSync("zip", ["-q", "-r", "-9", "out.zip", "pkg"], { cwd: dir });
    const entries = unzip(new Uint8Array(fs.readFileSync(path.join(dir, "out.zip"))));
    expect(entries.map((e) => e.name).sort()).toEqual(["pkg/files/a.json", "pkg/translations.tsv"]);
    expect(dec(entries.find((e) => e.name.endsWith(".tsv"))!.bytes)).toBe(text);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("not a zip / damaged", () => {
    expect(() => unzip(enc("hello"))).toThrow(AppError);
    const z = zip([{ name: "a.txt", bytes: enc("abc") }]);
    z[z.indexOf(0x61, 30 + 5)] = 0x78; // change the content: CRC no longer matches
    expect(() => unzip(z)).toThrow("CRC");
  });
});
