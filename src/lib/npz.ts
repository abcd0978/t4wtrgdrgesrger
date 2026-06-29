/** Browser .npz / .npy decoder. No deps: zip via native DecompressionStream.
 *
 * .npz = a zip (STORE or deflate) of .npy entries.
 * .npy = magic \x93NUMPY + ascii header dict {descr, fortran_order, shape} + raw LE data.
 *
 * ponytail: handles only what numpy's savez emits (C-order, seekable zip with
 * sizes in the local header). fortran_order=True and streamed zip entries
 * (size-in-data-descriptor) are not supported — assert if hit, don't silently
 * mis-decode. Upgrade to a real zip lib only if a server actually sends those.
 */

const DTYPE: Record<string, { ctor: new (b: ArrayBuffer) => ArrayBufferView; bytes: number }> = {
  "<f4": { ctor: Float32Array, bytes: 4 },
  "<f8": { ctor: Float64Array, bytes: 8 },
  "<f2": { ctor: Uint16Array, bytes: 2 }, // half: kept as raw u16, caller converts
  "|u1": { ctor: Uint8Array, bytes: 1 },
  "<u2": { ctor: Uint16Array, bytes: 2 },
  "<u4": { ctor: Uint32Array, bytes: 4 },
  "|i1": { ctor: Int8Array, bytes: 1 },
  "<i2": { ctor: Int16Array, bytes: 2 },
  "<i4": { ctor: Int32Array, bytes: 4 },
  "<i8": { ctor: BigInt64Array, bytes: 8 }, // aux arrays (voxel_key, stamps); decoded but unused
  "<u8": { ctor: BigUint64Array, bytes: 8 },
};

export interface NpyArray {
  dtype: string;
  shape: number[];
  data: ArrayBufferView; // typed by dtype
}

async function inflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream("deflate-raw");
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function parseNpy(bytes: Uint8Array): NpyArray {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // magic: \x93 N U M P Y  (6 bytes), then major/minor version.
  if (bytes[0] !== 0x93) throw new Error("not a .npy file");
  const major = bytes[6];
  let headerLen: number, headerStart: number;
  if (major === 1) {
    headerLen = dv.getUint16(8, true);
    headerStart = 10;
  } else {
    headerLen = dv.getUint32(8, true);
    headerStart = 12;
  }
  const header = new TextDecoder().decode(bytes.subarray(headerStart, headerStart + headerLen));
  const descr = /'descr':\s*'([^']+)'/.exec(header)?.[1];
  const fortran = /'fortran_order':\s*(True|False)/.exec(header)?.[1];
  const shapeStr = /'shape':\s*\(([^)]*)\)/.exec(header)?.[1];
  if (!descr || shapeStr === undefined) throw new Error(`bad npy header: ${header}`);
  if (fortran === "True") throw new Error("fortran_order=True not supported");
  const shape = shapeStr.split(",").map((s) => s.trim()).filter(Boolean).map(Number);
  const d = DTYPE[descr];
  if (!d) throw new Error(`unsupported dtype ${descr}`);

  const count = shape.reduce((a, b) => a * b, 1);
  const dataStart = headerStart + headerLen;
  // Copy to a fresh buffer so the typed-array view is correctly aligned.
  const slice = bytes.buffer.slice(
    bytes.byteOffset + dataStart,
    bytes.byteOffset + dataStart + count * d.bytes,
  );
  return { dtype: descr, shape, data: new d.ctor(slice as ArrayBuffer) };
}

/** Decode an .npz ArrayBuffer into { arrayName: NpyArray }. */
export async function unzipNpz(buf: ArrayBuffer): Promise<Record<string, NpyArray>> {
  const dv = new DataView(buf);
  const out: Record<string, NpyArray> = {};
  let off = 0;
  while (off + 4 <= dv.byteLength) {
    const sig = dv.getUint32(off, true);
    if (sig !== 0x04034b50) break; // PK\x03\x04 — else we've reached central directory
    const flags = dv.getUint16(off + 6, true);
    if (flags & 0x08) throw new Error("zip data descriptor (streamed) not supported");
    const method = dv.getUint16(off + 8, true);
    let compSize = dv.getUint32(off + 18, true);
    const uncompSize32 = dv.getUint32(off + 22, true);
    const nameLen = dv.getUint16(off + 26, true);
    const extraLen = dv.getUint16(off + 28, true);
    const nameStart = off + 30;
    const extraStart = nameStart + nameLen;
    // ZIP64: 32-bit size fields are 0xFFFFFFFF; the real sizes live in the extra
    // field. numpy's savez streams each entry, so it writes ZIP64 local headers.
    if (compSize === 0xffffffff) {
      let p = extraStart;
      const end = extraStart + extraLen;
      while (p + 4 <= end) {
        const id = dv.getUint16(p, true);
        const sz = dv.getUint16(p + 2, true);
        if (id === 0x0001) {
          let q = p + 4;
          if (uncompSize32 === 0xffffffff) q += 8; // skip uncompressed size, take compressed
          compSize = Number(dv.getBigUint64(q, true));
          break;
        }
        p += 4 + sz;
      }
      if (compSize === 0xffffffff) throw new Error("ZIP64 extra field not found");
    }
    const name = new TextDecoder().decode(new Uint8Array(buf, nameStart, nameLen));
    const dataStart = extraStart + extraLen;
    const comp = new Uint8Array(buf, dataStart, compSize);
    let npy: Uint8Array;
    if (method === 0) npy = comp; // STORE (numpy savez default)
    else if (method === 8) npy = await inflateRaw(comp); // deflate (savez_compressed)
    else throw new Error(`unsupported zip method ${method}`);
    out[name.replace(/\.npy$/, "")] = parseNpy(npy);
    off = dataStart + compSize;
  }
  return out;
}
