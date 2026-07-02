/** antimatter15/splat ".splat" format -> packed (N,8) uint32 buffer.
 *
 * Each .splat record is 32 bytes:
 *   [0:12)  position xyz (3x f32)
 *   [12:24) scale xyz (3x f32, linear)
 *   [24:28) color RGBA (4x u8)
 *   [28:32) rotation quaternion wxyz (4x u8, stored as q*128+128)
 *
 * These files come from the 3DGS/COLMAP ecosystem, which is y-down; the viewer
 * is z-up. `toZUp` rotates the scene -90° about X ((x,y,z) -> (x,z,-y)) so
 * scenes load roughly upright (fine-tune with 씬 회전 if needed).
 *
 * Records are converted one at a time straight into the packed output (no
 * whole-file intermediate arrays), so peak memory stays ~1x the payload —
 * this is what lets 200MB-class scenes (bicycle/garden) load without killing
 * the tab. fetchSplatToPacked converts while downloading for the same reason.
 */
import { DataUtils } from "three";
import { covarianceFromScaleRotation } from "./mathUtils";

const C = Math.SQRT1_2; // Rx(-90°) quaternion = (C, -C, 0, 0)

// Per-record scratch (module-level: single-threaded, reused across records).
const s3 = new Float32Array(3);
const q4 = new Float32Array(4);
const cov6 = new Float32Array(6);

/** Convert one 32-byte .splat record at src[so] into one 32-byte packed
 * gaussian at dst[doff]. */
function packRecord(src: DataView, so: number, dst: DataView, doff: number, toZUp: boolean) {
  const x = src.getFloat32(so, true), y = src.getFloat32(so + 4, true), z = src.getFloat32(so + 8, true);
  if (toZUp) {
    dst.setFloat32(doff, x, true); dst.setFloat32(doff + 4, z, true); dst.setFloat32(doff + 8, -y, true);
  } else {
    dst.setFloat32(doff, x, true); dst.setFloat32(doff + 4, y, true); dst.setFloat32(doff + 8, z, true);
  }
  dst.setUint32(doff + 12, 0, true); // group index (filled at merge time)
  s3[0] = src.getFloat32(so + 12, true);
  s3[1] = src.getFloat32(so + 16, true);
  s3[2] = src.getFloat32(so + 20, true);
  const qw = (src.getUint8(so + 28) - 128) / 128;
  const qx = (src.getUint8(so + 29) - 128) / 128;
  const qy = (src.getUint8(so + 30) - 128) / 128;
  const qz = (src.getUint8(so + 31) - 128) / 128;
  if (toZUp) {
    // Premultiply by the Rx(-90°) quaternion (expanded product; the result is
    // normalized inside covarianceFromScaleRotation).
    q4[0] = C * (qw + qx); q4[1] = C * (qx - qw); q4[2] = C * (qy + qz); q4[3] = C * (qz - qy);
  } else {
    q4[0] = qw; q4[1] = qx; q4[2] = qy; q4[3] = qz;
  }
  covarianceFromScaleRotation(s3, q4, 1, cov6);
  for (let k = 0; k < 6; k++) dst.setUint16(doff + 16 + k * 2, DataUtils.toHalfFloat(cov6[k]), true);
  dst.setUint8(doff + 28, src.getUint8(so + 24));
  dst.setUint8(doff + 29, src.getUint8(so + 25));
  dst.setUint8(doff + 30, src.getUint8(so + 26));
  dst.setUint8(doff + 31, src.getUint8(so + 27));
}

/** Whole in-memory .splat buffer -> packed (local file open). */
export function splatToPacked(data: ArrayBuffer, toZUp = false): Uint32Array {
  const n = Math.floor(data.byteLength / 32);
  if (n === 0) throw new Error("splat: empty file");
  const src = new DataView(data);
  const packed = new Uint32Array(n * 8);
  const dst = new DataView(packed.buffer);
  for (let i = 0; i < n; i++) packRecord(src, i * 32, dst, i * 32, toZUp);
  return packed;
}

/** Stream a .splat URL directly into a packed buffer, converting records as
 * chunks arrive. Progress reports bytes and splats converted so far. */
export async function fetchSplatToPacked(
  url: string,
  toZUp: boolean,
  onProgress: (loaded: number, total: number, splats: number) => void,
): Promise<Uint32Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  if (!res.body) return splatToPacked(await res.arrayBuffer(), toZUp);
  const total = parseInt(res.headers.get("Content-Length") ?? "0") || 0;

  // Preallocate from Content-Length when known; grow geometrically otherwise.
  let packed = new Uint32Array(Math.max(1, total ? Math.floor(total / 32) : 1 << 17) * 8);
  let dst = new DataView(packed.buffer);
  const ensure = (records: number) => {
    if (records * 8 <= packed.length) return;
    const grown = new Uint32Array(Math.max(records, (packed.length / 8) * 2) * 8);
    grown.set(packed);
    packed = grown;
    dst = new DataView(packed.buffer);
  };

  // Carry buffer for a record split across chunk boundaries.
  const carry = new Uint8Array(32);
  const carryView = new DataView(carry.buffer);
  let carryLen = 0, nRec = 0, loaded = 0;

  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    loaded += value.length;
    let off = 0;
    if (carryLen > 0) {
      const take = Math.min(32 - carryLen, value.length);
      carry.set(value.subarray(0, take), carryLen);
      carryLen += take; off = take;
      if (carryLen === 32) {
        ensure(nRec + 1);
        packRecord(carryView, 0, dst, nRec * 32, toZUp);
        nRec++; carryLen = 0;
      }
    }
    const whole = Math.floor((value.length - off) / 32);
    if (whole > 0) {
      const src = new DataView(value.buffer, value.byteOffset + off, whole * 32);
      ensure(nRec + whole);
      for (let r = 0; r < whole; r++) packRecord(src, r * 32, dst, (nRec + r) * 32, toZUp);
      nRec += whole;
      off += whole * 32;
    }
    if (off < value.length) {
      carry.set(value.subarray(off));
      carryLen = value.length - off;
    }
    onProgress(loaded, total, nRec);
  }
  if (nRec === 0) throw new Error("splat: empty file");
  return nRec * 8 === packed.length ? packed : packed.slice(0, nRec * 8);
}
