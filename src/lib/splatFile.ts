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
 */
import { covarianceFromScaleRotation } from "./mathUtils";
import { packSplats } from "./pack";

const C = Math.SQRT1_2; // Rx(-90°) quaternion = (C, -C, 0, 0)

export function splatToPacked(data: ArrayBuffer, toZUp = false): Uint32Array {
  const n = Math.floor(data.byteLength / 32);
  if (n === 0) throw new Error("splat: empty file");
  const dv = new DataView(data);
  const centers = new Float32Array(n * 3);
  const scales = new Float32Array(n * 3);
  const wxyz = new Float32Array(n * 4);
  const rgb = new Float32Array(n * 3);
  const opacity = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const b = i * 32;
    const x = dv.getFloat32(b, true), y = dv.getFloat32(b + 4, true), z = dv.getFloat32(b + 8, true);
    if (toZUp) { centers[i * 3] = x; centers[i * 3 + 1] = z; centers[i * 3 + 2] = -y; }
    else { centers[i * 3] = x; centers[i * 3 + 1] = y; centers[i * 3 + 2] = z; }
    scales[i * 3] = dv.getFloat32(b + 12, true);
    scales[i * 3 + 1] = dv.getFloat32(b + 16, true);
    scales[i * 3 + 2] = dv.getFloat32(b + 20, true);
    rgb[i * 3] = dv.getUint8(b + 24);
    rgb[i * 3 + 1] = dv.getUint8(b + 25);
    rgb[i * 3 + 2] = dv.getUint8(b + 26);
    opacity[i] = dv.getUint8(b + 27);
    const qw = (dv.getUint8(b + 28) - 128) / 128;
    const qx = (dv.getUint8(b + 29) - 128) / 128;
    const qy = (dv.getUint8(b + 30) - 128) / 128;
    const qz = (dv.getUint8(b + 31) - 128) / 128;
    if (toZUp) {
      // Premultiply by the Rx(-90°) quaternion (expanded product; the result
      // is normalized inside covarianceFromScaleRotation).
      wxyz[i * 4] = C * (qw + qx);
      wxyz[i * 4 + 1] = C * (qx - qw);
      wxyz[i * 4 + 2] = C * (qy + qz);
      wxyz[i * 4 + 3] = C * (qz - qy);
    } else {
      wxyz[i * 4] = qw; wxyz[i * 4 + 1] = qx; wxyz[i * 4 + 2] = qy; wxyz[i * 4 + 3] = qz;
    }
  }
  const covTriu = covarianceFromScaleRotation(scales, wxyz, n);
  return packSplats(n, centers, covTriu, rgb, opacity, true, true);
}

/** Fetch a binary with download-progress callbacks (loaded/total bytes;
 * total is 0 when the server doesn't send Content-Length). */
export async function fetchWithProgress(
  url: string,
  onProgress: (loaded: number, total: number) => void,
): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  if (!res.body) return await res.arrayBuffer();
  const total = parseInt(res.headers.get("Content-Length") ?? "0") || 0;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    onProgress(loaded, total);
  }
  const out = new Uint8Array(loaded);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out.buffer;
}
