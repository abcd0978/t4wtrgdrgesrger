/** Pack Gaussians into viser's 32-byte/Gaussian GPU layout (N x 8 uint32):
 *   [0:3] center xyz (f32) | [3] group (u32=0) | [4:7] cov upper-tri 6x f16 | [7] rgba (4x u8)
 * Mirrors viser's add_gaussian_splats packing + example pack_splats.
 */
import { DataUtils } from "three";
import { unzipNpz, type NpyArray } from "./npz";

function toF32(a: NpyArray): Float32Array {
  // ponytail: assumes float/int source dtype (f4/f8/u1...), not raw f16.
  return a.data instanceof Float32Array ? a.data : new Float32Array(a.data as unknown as ArrayLike<number>);
}

/** Upper-triangular [Σ00,Σ01,Σ02,Σ11,Σ12,Σ22] from full (N,3,3) covariances. */
function covTriuFromFull(cov: Float32Array, n: number): Float32Array {
  const out = new Float32Array(n * 6);
  const idx = [0, 1, 2, 4, 5, 8];
  for (let i = 0; i < n; i++) for (let k = 0; k < 6; k++) out[i * 6 + k] = cov[i * 9 + idx[k]];
  return out;
}

/** Σ = R diag(s²) Rᵀ from per-Gaussian scale (s) and quaternion (wxyz, w-first). */
function covTriuFromScaleRot(scales: Float32Array, wxyz: Float32Array, n: number): Float32Array {
  const out = new Float32Array(n * 6);
  for (let i = 0; i < n; i++) {
    const sx = scales[i * 3], sy = scales[i * 3 + 1], sz = scales[i * 3 + 2];
    let w = wxyz[i * 4], x = wxyz[i * 4 + 1], y = wxyz[i * 4 + 2], z = wxyz[i * 4 + 3];
    const nrm = Math.hypot(w, x, y, z) || 1e-12; // normalize (matches gaussian_splats._make_covariances)
    w /= nrm; x /= nrm; y /= nrm; z /= nrm;
    // rotation matrix R (row-major)
    const r00 = 1 - 2 * (y * y + z * z), r01 = 2 * (x * y - w * z), r02 = 2 * (x * z + w * y);
    const r10 = 2 * (x * y + w * z), r11 = 1 - 2 * (x * x + z * z), r12 = 2 * (y * z - w * x);
    const r20 = 2 * (x * z - w * y), r21 = 2 * (y * z + w * x), r22 = 1 - 2 * (x * x + y * y);
    const dx = sx * sx, dy = sy * sy, dz = sz * sz;
    // Σ = R D Rᵀ ; only need upper triangle
    out[i * 6 + 0] = r00 * r00 * dx + r01 * r01 * dy + r02 * r02 * dz; // 00
    out[i * 6 + 1] = r00 * r10 * dx + r01 * r11 * dy + r02 * r12 * dz; // 01
    out[i * 6 + 2] = r00 * r20 * dx + r01 * r21 * dy + r02 * r22 * dz; // 02
    out[i * 6 + 3] = r10 * r10 * dx + r11 * r11 * dy + r12 * r12 * dz; // 11
    out[i * 6 + 4] = r10 * r20 * dx + r11 * r21 * dy + r12 * r22 * dz; // 12
    out[i * 6 + 5] = r20 * r20 * dx + r21 * r21 * dy + r22 * r22 * dz; // 22
  }
  return out;
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
    covTriu = covTriuFromFull(toF32(covA), n);
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
    covTriu = covTriuFromScaleRot(toF32(scalesA), wxyz, n);
  }

  const rgbA = pick(arrays, ["rgbs", "colors", "color_rgb", "rgb"]);
  const opA = pick(arrays, ["opacities", "opacity", "alpha", "alphas"]);
  if (!rgbA || !opA) throw new Error("npz: no rgbs/opacities");
  return packSplats(n, centers, covTriu, toF32(rgbA), toF32(opA), rgbA.dtype === "|u1", opA.dtype === "|u1");
}

export { unzipNpz };
