// zip.ts - Minimal ZIP writer (stored, no compression) and reader (stored or deflate), for the
// fallback web build's save download and the translation packages (see package.ts). Pure logic, no
// runtime APIs: deflate is decoded here (RFC 1951), so it works the same on the desktop server, in
// the browser and in tests. No ZIP64, encryption or multi-disk archives.

import { AppError } from "./errors";

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export interface ZipEntry {
  name: string; // "/"-separated path inside the archive
  bytes: Uint8Array;
}

export function zip(files: ZipEntry[], date = new Date()): Uint8Array {
  const enc = new TextEncoder();
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const f of files) {
    const name = enc.encode(f.name);
    const crc = crc32(f.bytes);
    const head = (sig: number, central: boolean) => {
      const h = new DataView(new ArrayBuffer(central ? 46 : 30));
      let p = 0;
      const u32 = (v: number) => (h.setUint32(p, v, true), (p += 4));
      const u16 = (v: number) => (h.setUint16(p, v, true), (p += 2));
      u32(sig);
      if (central) u16(20); // version made by
      u16(20); // version needed
      u16(0x0800); // UTF-8 file names
      u16(0); // stored
      u16(time);
      u16(day);
      u32(crc);
      u32(f.bytes.length);
      u32(f.bytes.length);
      u16(name.length);
      u16(0); // extra
      if (central) {
        u16(0); // comment
        u16(0); // disk
        u16(0); // internal attributes
        u32(0); // external attributes
        u32(offset);
      }
      return new Uint8Array(h.buffer);
    };
    const local = head(0x04034b50, false);
    locals.push(local, name, f.bytes);
    centrals.push(head(0x02014b50, true), name);
    offset += local.length + name.length + f.bytes.length;
  }

  const centralSize = centrals.reduce((s, c) => s + c.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);

  const parts = [...locals, ...centrals, new Uint8Array(end.buffer)];
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let p = 0;
  for (const part of parts) {
    out.set(part, p);
    p += part.length;
  }
  return out;
}

export const isZip = (bytes: Uint8Array) => bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;

const bad = (detail: string) => new AppError("zip-invalid", `Not a usable ZIP file: ${detail}.`, { detail });

// The files of an archive (folders left out), read through its central directory. Names that are
// not marked UTF-8 are read as Latin-1 (Windows' built-in zip writes them in the local code page;
// package files only use ASCII names).
export function unzip(bytes: Uint8Array): ZipEntry[] {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (v.getUint32(i, true) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw bad("no end of central directory");
  const count = v.getUint16(end + 10, true);
  let p = v.getUint32(end + 16, true);
  const utf8 = new TextDecoder();
  const latin1 = new TextDecoder("latin1");
  const out: ZipEntry[] = [];
  for (let n = 0; n < count; n++) {
    if (p + 46 > bytes.length || v.getUint32(p, true) !== 0x02014b50) throw bad("broken central directory");
    const flags = v.getUint16(p + 8, true);
    const method = v.getUint16(p + 10, true);
    const crc = v.getUint32(p + 16, true);
    const size = v.getUint32(p + 20, true); // compressed
    const fullSize = v.getUint32(p + 24, true);
    const nameLen = v.getUint16(p + 28, true);
    const extraLen = v.getUint16(p + 30, true);
    const commentLen = v.getUint16(p + 32, true);
    const local = v.getUint32(p + 42, true);
    const nameBytes = bytes.subarray(p + 46, p + 46 + nameLen);
    const name = (flags & 0x0800 ? utf8 : latin1).decode(nameBytes).replace(/\\/g, "/");
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith("/")) continue;
    if (flags & 1) throw bad(`${name} is encrypted`);
    if (local + 30 > bytes.length || v.getUint32(local, true) !== 0x04034b50) throw bad(`broken entry ${name}`);
    const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
    const data = bytes.subarray(start, start + size);
    let content: Uint8Array;
    if (method === 0) content = data.slice();
    else if (method === 8) content = inflateRaw(data, fullSize);
    else throw bad(`${name} uses compression method ${method}`);
    if (crc32(content) !== crc) throw bad(`${name} is damaged (CRC)`);
    out.push({ name, bytes: content });
  }
  return out;
}

// ---- inflate (RFC 1951) ----

const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

// Canonical Huffman code: counts per length and the symbols sorted by code.
interface Huffman {
  counts: Uint16Array;
  symbols: Uint16Array;
}

function huffman(lengths: ArrayLike<number>): Huffman {
  const counts = new Uint16Array(16);
  for (let i = 0; i < lengths.length; i++) counts[lengths[i]!]!++;
  counts[0] = 0;
  const offs = new Uint16Array(16);
  for (let i = 1; i < 16; i++) offs[i] = offs[i - 1]! + counts[i - 1]!;
  const symbols = new Uint16Array(lengths.length);
  for (let i = 0; i < lengths.length; i++) if (lengths[i]) symbols[offs[lengths[i]!]!++] = i;
  return { counts, symbols };
}

const FIXED_LIT = huffman(Array.from({ length: 288 }, (_, i) => (i < 144 ? 8 : i < 256 ? 9 : i < 280 ? 7 : 8)));
const FIXED_DIST = huffman(new Array(30).fill(5));

export function inflateRaw(src: Uint8Array, expected = 0): Uint8Array {
  let out = new Uint8Array(Math.max(expected, src.length * 4, 1024));
  let len = 0;
  let pos = 0; // byte position in src
  let bit = 0; // bit buffer
  let nbits = 0;
  const need = (n: number) => {
    while (nbits < n) {
      if (pos >= src.length) throw bad("deflate data ends early");
      bit |= src[pos++]! << nbits;
      nbits += 8;
    }
  };
  const bits = (n: number) => {
    if (n === 0) return 0;
    need(n);
    const v = bit & ((1 << n) - 1);
    bit >>>= n;
    nbits -= n;
    return v;
  };
  const decode = (h: Huffman) => {
    let code = 0;
    let first = 0;
    let index = 0;
    for (let l = 1; l < 16; l++) {
      code |= bits(1);
      const count = h.counts[l]!;
      if (code - count < first) return h.symbols[index + (code - first)]!;
      index += count;
      first = (first + count) << 1;
      code <<= 1;
    }
    throw bad("bad Huffman code");
  };
  const ensure = (n: number) => {
    if (len + n <= out.length) return;
    const bigger = new Uint8Array(Math.max(out.length * 2, len + n));
    bigger.set(out.subarray(0, len));
    out = bigger;
  };

  let last = 0;
  while (!last) {
    last = bits(1);
    const type = bits(2);
    if (type === 0) {
      bit = 0;
      nbits = 0; // to the byte boundary
      if (pos + 4 > src.length) throw bad("deflate data ends early");
      const n = src[pos]! | (src[pos + 1]! << 8);
      pos += 4;
      if (pos + n > src.length) throw bad("deflate data ends early");
      ensure(n);
      out.set(src.subarray(pos, pos + n), len);
      len += n;
      pos += n;
      continue;
    }
    if (type === 3) throw bad("bad deflate block");
    let lit = FIXED_LIT;
    let dist = FIXED_DIST;
    if (type === 2) {
      const hlit = bits(5) + 257;
      const hdist = bits(5) + 1;
      const hclen = bits(4) + 4;
      const cl = new Uint8Array(19);
      for (let i = 0; i < hclen; i++) cl[CL_ORDER[i]!] = bits(3);
      const clh = huffman(cl);
      const lengths = new Uint8Array(hlit + hdist);
      for (let i = 0; i < hlit + hdist; ) {
        const sym = decode(clh);
        if (sym < 16) lengths[i++] = sym;
        else {
          const [rep, prev] = sym === 16 ? [3 + bits(2), i ? lengths[i - 1]! : -1] : sym === 17 ? [3 + bits(3), 0] : [11 + bits(7), 0];
          if (prev < 0 || i + rep > lengths.length) throw bad("bad code lengths");
          lengths.fill(prev, i, i + rep);
          i += rep;
        }
      }
      lit = huffman(lengths.subarray(0, hlit));
      dist = huffman(lengths.subarray(hlit));
    }
    for (;;) {
      const sym = decode(lit);
      if (sym < 256) {
        ensure(1);
        out[len++] = sym;
      } else if (sym === 256) break;
      else {
        const li = sym - 257;
        if (li >= 29) throw bad("bad length code");
        const n = LEN_BASE[li]! + bits(LEN_EXTRA[li]!);
        const di = decode(dist);
        if (di >= 30) throw bad("bad distance code");
        const d = DIST_BASE[di]! + bits(DIST_EXTRA[di]!);
        if (d > len) throw bad("distance too far back");
        ensure(n);
        for (let k = 0; k < n; k++, len++) out[len] = out[len - d]!;
      }
    }
  }
  return out.slice(0, len);
}
