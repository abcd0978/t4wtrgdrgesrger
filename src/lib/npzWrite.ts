/** Minimal .npy + .npz (STORE zip) writer — inverse of npz.ts, no deps.
 * Produces a plain (non-ZIP64, non-streamed) zip that both numpy and our own
 * unzipNpz can read. */

function crc32(bytes: Uint8Array): number {
  let c = ~0;
  for (let i = 0; i < bytes.length; i++) {
    c ^= bytes[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

/** Encode a typed array as a .npy v1.0 byte buffer. `descr` e.g. "<f4", "<i4". */
export function npyBytes(descr: string, shape: number[], data: ArrayBufferView): Uint8Array {
  const shapeStr = shape.length === 1 ? `${shape[0]},` : shape.join(", ");
  let header = `{'descr': '${descr}', 'fortran_order': False, 'shape': (${shapeStr}), }`;
  const base = 10; // \x93NUMPY + ver(2) + headerLen(2)
  const pad = (64 - ((base + header.length + 1) % 64)) % 64;
  header = header + " ".repeat(pad) + "\n";
  const headerB = new TextEncoder().encode(header);
  const out = new Uint8Array(base + headerB.length + data.byteLength);
  out.set([0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59, 1, 0], 0);
  new DataView(out.buffer).setUint16(8, headerB.length, true);
  out.set(headerB, base);
  out.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), base + headerB.length);
  return out;
}

/** Bundle named .npy byte buffers into a STORE (uncompressed) .npz Blob. */
export function makeNpz(entries: { name: string; bytes: Uint8Array }[]): Blob {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const { name, bytes } of entries) {
    const nameB = enc.encode(name);
    const crc = crc32(bytes);
    const lh = new Uint8Array(30 + nameB.length);
    const dv = new DataView(lh.buffer);
    dv.setUint32(0, 0x04034b50, true);
    dv.setUint16(4, 20, true);
    dv.setUint32(14, crc, true);
    dv.setUint32(18, bytes.length, true);
    dv.setUint32(22, bytes.length, true);
    dv.setUint16(26, nameB.length, true);
    lh.set(nameB, 30);
    chunks.push(lh, bytes);

    const cd = new Uint8Array(46 + nameB.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, bytes.length, true);
    cv.setUint32(24, bytes.length, true);
    cv.setUint16(28, nameB.length, true);
    cv.setUint32(42, offset, true);
    cd.set(nameB, 46);
    central.push(cd);
    offset += lh.length + bytes.length;
  }
  const centralStart = offset;
  let centralSize = 0;
  for (const c of central) { chunks.push(c); centralSize += c.length; }
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, centralStart, true);
  chunks.push(eocd);
  return new Blob(chunks as BlobPart[], { type: "application/octet-stream" });
}
