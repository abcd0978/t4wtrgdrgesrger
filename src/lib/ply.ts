/** Packed (N,8) uint32 gaussian buffer -> standard 3DGS binary PLY.
 * Inverse of pack.ts: covariance (upper-tri f16) is eigendecomposed back into
 * scale + rotation (see mathUtils). Gaussians with alpha 0 (deleted slots) are
 * dropped, so an export bakes in the edits. */
import { DataUtils } from "three";
import { covarianceToScaleRotation } from "./mathUtils";

const SH_C0 = 0.28209479177387814; // SH degree-0 basis (color <-> f_dc)

const PLY_PROPS = [
  "x", "y", "z", "nx", "ny", "nz",
  "f_dc_0", "f_dc_1", "f_dc_2", "opacity",
  "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3",
];

/** Packed buffer -> 3DGS binary PLY blob. Skips alpha-0 (deleted) gaussians. */
export function packedToPly(buffer: Uint32Array): Blob {
  const dv = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const slots = buffer.length / 8;
  const live: number[] = [];
  for (let i = 0; i < slots; i++) if (dv.getUint8(i * 32 + 31) !== 0) live.push(i);

  const header =
    "ply\nformat binary_little_endian 1.0\n" +
    `element vertex ${live.length}\n` +
    PLY_PROPS.map((p) => `property float ${p}`).join("\n") +
    "\nend_header\n";
  const headerBytes = new TextEncoder().encode(header);

  const recSize = PLY_PROPS.length * 4;
  const out = new ArrayBuffer(headerBytes.byteLength + live.length * recSize);
  new Uint8Array(out).set(headerBytes, 0);
  const odv = new DataView(out, headerBytes.byteLength);

  const cov6 = [0, 0, 0, 0, 0, 0];
  const fdc = (c: number) => (c / 255 - 0.5) / SH_C0;
  let o = 0;
  for (const i of live) {
    const b = i * 32;
    for (let k = 0; k < 6; k++) cov6[k] = DataUtils.fromHalfFloat(dv.getUint16(b + 16 + k * 2, true));
    const { scale, quaternion } = covarianceToScaleRotation(cov6);
    const alpha = Math.min(0.999999, Math.max(1e-6, dv.getUint8(b + 31) / 255));
    const rec = [
      dv.getFloat32(b, true), dv.getFloat32(b + 4, true), dv.getFloat32(b + 8, true),
      0, 0, 0,
      fdc(dv.getUint8(b + 28)), fdc(dv.getUint8(b + 29)), fdc(dv.getUint8(b + 30)),
      Math.log(alpha / (1 - alpha)),
      Math.log(Math.max(scale[0], 1e-9)), Math.log(Math.max(scale[1], 1e-9)), Math.log(Math.max(scale[2], 1e-9)),
      quaternion[0], quaternion[1], quaternion[2], quaternion[3],
    ];
    for (const v of rec) { odv.setFloat32(o, v, true); o += 4; }
  }
  return new Blob([out], { type: "application/octet-stream" });
}
