// zip.ts - A minimal ZIP writer (stored, no compression) so the fallback web build can hand over
// several saved files as one download (paths inside it relative to the workspace root).

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

export function zip(files: { name: string; bytes: Uint8Array }[], date = new Date()): Uint8Array {
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
