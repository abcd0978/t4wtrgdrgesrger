/** Pack Gaussians into viser's 32-byte/Gaussian GPU layout (N x 8 uint32):
 *   [0:3] center xyz (f32) | [3] group (u32=0) | [4:7] cov upper-tri 6x f16 | [7] rgba (4x u8)
 * Mirrors viser's add_gaussian_splats packing + example pack_splats.
 */
import { DataUtils } from "three";
import { unzipNpz, type NpyArray } from "./npz";
import { covarianceUpperTriFromMatrix, covarianceFromScaleRotation } from "./mathUtils";

function toF32(a: NpyArray): Float32Array {
  // ponytail: assumes float/int source dtype (f4/f8/u1...), not raw f16.
  return a.data instanceof Float32Array ? a.data : new Float32Array(a.data as unknown as ArrayLike<number>);
}

export function packSplats(
  n: number,
  centers: Float32Array,
  covTriu: Float32Array,
  rgb: Float32Array,
  opacity: Float32Array,
  rgbIsU8: boolean,
  opIsU8: boolean,
): Uint32Array {
  const buf = new Uint32Array(n * 8);
  const dv = new DataView(buf.buffer);
  // numpy astype(uint8) truncates (floor for >=0), not round — match it exactly.
  const clampU8 = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : Math.floor(v));
  const sc = (v: number, isU8: boolean) => clampU8(isU8 ? v : v * 255);
  for (let i = 0; i < n; i++) {
    const b = i * 32;
    dv.setFloat32(b + 0, centers[i * 3 + 0], true);
    dv.setFloat32(b + 4, centers[i * 3 + 1], true);
    dv.setFloat32(b + 8, centers[i * 3 + 2], true);
    dv.setUint32(b + 12, 0, true); // group index
    for (let k = 0; k < 6; k++) dv.setUint16(b + 16 + k * 2, DataUtils.toHalfFloat(covTriu[i * 6 + k]), true);
    dv.setUint8(b + 28, sc(rgb[i * 3 + 0], rgbIsU8));
    dv.setUint8(b + 29, sc(rgb[i * 3 + 1], rgbIsU8));
    dv.setUint8(b + 30, sc(rgb[i * 3 + 2], rgbIsU8));
    dv.setUint8(b + 31, sc(opacity[i], opIsU8));
  }
  return buf;
}

function pick(arrays: Record<string, NpyArray>, names: string[]): NpyArray | null {
  for (const n of names) if (arrays[n]) return arrays[n];
  return null;
}

/** npz arrays (viser/example key conventions) -> packed (N,8) uint32 buffer. */
export function npzToPacked(arrays: Record<string, NpyArray>): Uint32Array {
  const centersA = pick(arrays, ["centers", "means", "means3d", "mean_xyz", "xyz", "positions"]);
  if (!centersA) throw new Error("npz: no centers/means/xyz");
  const n = centersA.shape[0];
  const centers = toF32(centersA);

  let covTriu: Float32Array;
  const covA = pick(arrays, ["covariances", "covars", "covs"]);
  if (covA) {
    covTriu = covarianceUpperTriFromMatrix(toF32(covA), n);
  } else {
    const scalesA = pick(arrays, ["scales", "scale", "scale_xyz"]);
    if (!scalesA) throw new Error("npz: no covariances and no scales");
    // Rotation as wxyz (w-first); rotation_xyzw is reordered to wxyz like the server's client.
    let wxyz: Float32Array | null = null;
    const wxyzA = pick(arrays, ["wxyzs", "quats", "rotations", "rot"]);
    const xyzwA = pick(arrays, ["rotation_xyzw", "xyzw"]);
    if (wxyzA) {
      wxyz = toF32(wxyzA);
    } else if (xyzwA) {
      const q = toF32(xyzwA);
      wxyz = new Float32Array(n * 4);
      for (let i = 0; i < n; i++) {
        wxyz[i * 4] = q[i * 4 + 3]; // w
        wxyz[i * 4 + 1] = q[i * 4]; // x
        wxyz[i * 4 + 2] = q[i * 4 + 1]; // y
        wxyz[i * 4 + 3] = q[i * 4 + 2]; // z
      }
    }
    if (!wxyz) throw new Error("npz: no rotation (wxyz/quats/rotation_xyzw)");
    // ponytail: scale_xyz/scales taken linearly. log-scale columns (scale_0..2)
    // would need exp() — add when a run actually ships those.
    covTriu = covarianceFromScaleRotation(toF32(scalesA), wxyz, n);
  }

  const rgbA = pick(arrays, ["rgbs", "colors", "color_rgb", "rgb"]);
  const opA = pick(arrays, ["opacities", "opacity", "alpha", "alphas"]);
  if (!rgbA || !opA) throw new Error("npz: no rgbs/opacities");
  return packSplats(n, centers, covTriu, toF32(rgbA), toF32(opA), rgbA.dtype === "|u1", opA.dtype === "|u1");
}

export { unzipNpz };
