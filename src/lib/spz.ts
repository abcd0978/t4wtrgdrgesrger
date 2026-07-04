/** Niantic .spz (v2) -> packed (N,8) uint32 buffer (+ optional SH1 side buffer).
 *
 * β: implemented from the published spec; field order follows the reference
 * struct (positions, scales, rotations, alphas, colors, sh). The container is
 * gzip; inside:
 *   header (16B LE): magic "NGSP" u32 | version u32 | numPoints u32 |
 *                    shDegree u8 | fractionalBits u8 | flags u8 | reserved u8
 *   positions: n×3 × int24 LE fixed-point (value / 2^fractionalBits)
 *   scales:    n×3 × u8, scale = exp(u8/16 - 10)
 *   rotations: n×3 × u8 (quaternion xyz as u8/127.5-1; w = sqrt(1-|xyz|²))
 *   alphas:    n   × u8 (opacity, sigmoid already applied)
 *   colors:    n×3 × u8, f_dc = (u8/255 - 0.5) / 0.15 -> rgb = 0.5 + SH_C0·f_dc
 *   sh:        n × shDim×3 u8 (coefficient-major rgb), value = (u8-128)/128
 *
 * Like .splat, spz scenes come from the y-down 3DGS world; `toZUp` applies
 * the same -90° X rotation as the .splat loader.
 */
import { DataUtils } from "three";
import { covarianceFromScaleRotation } from "./mathUtils";

const SH_C0 = 0.28209479177387814;
const C = Math.SQRT1_2; // Rx(-90°) quaternion = (C, -C, 0, 0)
const s3 = new Float32Array(3);
const q4 = new Float32Array(4);
const cov6 = new Float32Array(6);

async function gunzip(data: ArrayBuffer): Promise<Uint8Array> {
  if (typeof DecompressionStream === "undefined") throw new Error("spz: 브라우저가 gzip 해제를 지원하지 않음");
  const stream = new Response(data).body!.pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const shDimOf = (deg: number) => (deg === 1 ? 3 : deg === 2 ? 8 : deg === 3 ? 15 : 0);

export async function spzToPacked(data: ArrayBuffer, toZUp = true): Promise<{ buffer: Uint32Array; sh1: Uint32Array | null }> {
  const raw = await gunzip(data);
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  if (raw.length < 16 || dv.getUint32(0, true) !== 0x5053474e) throw new Error("spz: 잘못된 매직 넘버");
  const version = dv.getUint32(4, true);
  if (version !== 2 && version !== 3) throw new Error(`spz: 지원하지 않는 버전 (${version})`);
  const n = dv.getUint32(8, true);
  const shDegree = raw[12];
  const fracBits = raw[13];
  const shDim = shDimOf(shDegree);
  const div = 1 << fracBits;

  let off = 16;
  const posOff = off; off += n * 9;
  const scaleOff = off; off += n * 3;
  const rotOff = off; off += n * 3;
  const alphaOff = off; off += n;
  const colorOff = off; off += n * 3;
  const shOff = off; off += n * shDim * 3;
  if (raw.length < off - n * shDim * 3) throw new Error("spz: 파일이 잘림");
  const hasSh = shDim >= 3 && raw.length >= shOff + n * shDim * 3;

  const int24 = (o: number) => {
    let v = raw[o] | (raw[o + 1] << 8) | (raw[o + 2] << 16);
    if (v & 0x800000) v -= 1 << 24;
    return v / div;
  };

  const packed = new Uint32Array(n * 8);
  const dst = new DataView(packed.buffer);
  const sh1 = hasSh ? new Uint32Array(n * 8) : null;
  const sh1dv = sh1 ? new DataView(sh1.buffer) : null;

  for (let i = 0; i < n; i++) {
    const b = i * 32;
    const x = int24(posOff + i * 9), y = int24(posOff + i * 9 + 3), z = int24(posOff + i * 9 + 6);
    if (toZUp) {
      dst.setFloat32(b, x, true); dst.setFloat32(b + 4, z, true); dst.setFloat32(b + 8, -y, true);
    } else {
      dst.setFloat32(b, x, true); dst.setFloat32(b + 4, y, true); dst.setFloat32(b + 8, z, true);
    }
    dst.setUint32(b + 12, 0, true);

    s3[0] = Math.exp(raw[scaleOff + i * 3] / 16 - 10);
    s3[1] = Math.exp(raw[scaleOff + i * 3 + 1] / 16 - 10);
    s3[2] = Math.exp(raw[scaleOff + i * 3 + 2] / 16 - 10);

    const qx = raw[rotOff + i * 3] / 127.5 - 1;
    const qy = raw[rotOff + i * 3 + 1] / 127.5 - 1;
    const qz = raw[rotOff + i * 3 + 2] / 127.5 - 1;
    const qw = Math.sqrt(Math.max(0, 1 - qx * qx - qy * qy - qz * qz));
    if (toZUp) {
      q4[0] = C * (qw + qx); q4[1] = C * (qx - qw); q4[2] = C * (qy + qz); q4[3] = C * (qz - qy);
    } else {
      q4[0] = qw; q4[1] = qx; q4[2] = qy; q4[3] = qz;
    }
    covarianceFromScaleRotation(s3, q4, 1, cov6);
    for (let k = 0; k < 6; k++) dst.setUint16(b + 16 + k * 2, DataUtils.toHalfFloat(cov6[k]), true);

    for (let ch = 0; ch < 3; ch++) {
      const fdc = (raw[colorOff + i * 3 + ch] / 255 - 0.5) / 0.15;
      const c8 = Math.round(Math.min(1, Math.max(0, 0.5 + SH_C0 * fdc)) * 255);
      dst.setUint8(b + 28 + ch, c8);
    }
    dst.setUint8(b + 31, raw[alphaOff + i]);

    if (sh1dv) {
      // spz sh: coefficient-major rgb triples; our side buffer is channel-major.
      const so = shOff + i * shDim * 3;
      for (let ch = 0; ch < 3; ch++)
        for (let k = 0; k < 3; k++)
          sh1dv.setUint16(b + (ch * 3 + k) * 2, DataUtils.toHalfFloat((raw[so + k * 3 + ch] - 128) / 128), true);
    }
  }
  return { buffer: packed, sh1 };
}
