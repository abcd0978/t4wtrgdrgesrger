/** Small shared helpers for in-place editing of the packed gaussian buffer.
 * Layout per gaussian (32 bytes): xyz f32 | group u32 | cov 6×f16 | rgba 4×u8. */
import { DataUtils } from "three";

/** "#rrggbb" -> [r,g,b] (0-255). */
export const hexToRgb = (hex: string): [number, number, number] =>
  [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];

/** DataView over the buffer's own range (handles subarray byteOffset). */
export const viewOf = (buf: Uint32Array) => new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

/** Read the upper-tri covariance (6× f16) at gaussian byte-base into `out`. */
export function readCov6(dv: DataView, base: number, out: number[]): void {
  for (let k = 0; k < 6; k++) out[k] = DataUtils.fromHalfFloat(dv.getUint16(base + 16 + k * 2, true));
}

/** Write the upper-tri covariance (6× f16) at gaussian byte-base. */
export function writeCov6(dv: DataView, base: number, cov: number[]): void {
  for (let k = 0; k < 6; k++) dv.setUint16(base + 16 + k * 2, DataUtils.toHalfFloat(cov[k]), true);
}

/** Average colour of the given gaussian indices as "#rrggbb". */
export function avgColorHex(dv: DataView, indices: Iterable<number>, count: number): string {
  if (count === 0) return "#cccccc";
  let r = 0, g = 0, b = 0;
  for (const i of indices) { const o = i * 32; r += dv.getUint8(o + 28); g += dv.getUint8(o + 29); b += dv.getUint8(o + 30); }
  const hx = (v: number) => Math.round(v / count).toString(16).padStart(2, "0");
  return `#${hx(r)}${hx(g)}${hx(b)}`;
}
