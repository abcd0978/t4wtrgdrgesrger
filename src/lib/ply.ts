/** Packed (N,8) uint32 gaussian buffer -> standard 3DGS binary PLY.
 * Inverse of pack.ts: covariance (upper-tri f16) is eigendecomposed back into
 * scale + rotation (see mathUtils). Gaussians with alpha 0 (deleted slots) are
 * dropped, so an export bakes in the edits. */
import { DataUtils } from "three";
import { covarianceToScaleRotation, covarianceFromScaleRotation } from "./mathUtils";
import { packSplats } from "./pack";

const SH_C0 = 0.28209479177387814; // SH degree-0 basis (color <-> f_dc)

const PLY_PROPS = [
  "x", "y", "z", "nx", "ny", "nz",
  "f_dc_0", "f_dc_1", "f_dc_2", "opacity",
  "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3",
];

/** Packed buffer -> 3DGS binary PLY blob. Skips alpha-0 (deleted) gaussians.
 * If `frames` (per-slot frame index) is given, a non-standard `ushort frame`
 * property is appended so the timeline can be rebuilt on re-load (other viewers
 * ignore the extra property). */
export function packedToPly(buffer: Uint32Array, frames?: Uint32Array): Blob {
  const dv = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const slots = buffer.length / 8;
  const live: number[] = [];
  for (let i = 0; i < slots; i++) if (dv.getUint8(i * 32 + 31) !== 0) live.push(i);

  const header =
    "ply\nformat binary_little_endian 1.0\n" +
    `element vertex ${live.length}\n` +
    PLY_PROPS.map((p) => `property float ${p}`).join("\n") +
    (frames ? "\nproperty ushort frame" : "") +
    "\nend_header\n";
  const headerBytes = new TextEncoder().encode(header);

  const recSize = PLY_PROPS.length * 4 + (frames ? 2 : 0);
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
    if (frames) { odv.setUint16(o, Math.min(65535, frames[i]), true); o += 2; }
  }
  return new Blob([out], { type: "application/octet-stream" });
}

// --- import: standard 3DGS binary PLY -> packed buffer (inverse of packedToPly) ---

const TYPE_SIZE: Record<string, number> = {
  char: 1, uchar: 1, int8: 1, uint8: 1, short: 2, ushort: 2, int16: 2, uint16: 2,
  int: 4, uint: 4, int32: 4, uint32: 4, float: 4, float32: 4, double: 8, float64: 8,
};

function readType(dv: DataView, off: number, type: string): number {
  switch (type) {
    case "float": case "float32": return dv.getFloat32(off, true);
    case "double": case "float64": return dv.getFloat64(off, true);
    case "uchar": case "uint8": return dv.getUint8(off);
    case "char": case "int8": return dv.getInt8(off);
    case "ushort": case "uint16": return dv.getUint16(off, true);
    case "short": case "int16": return dv.getInt16(off, true);
    case "uint": case "uint32": return dv.getUint32(off, true);
    case "int": case "int32": return dv.getInt32(off, true);
    default: return 0;
  }
}

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

/** Parse a 3DGS binary_little_endian PLY into the packed (N,8) uint32 buffer.
 * Handles f_dc color + opacity/scale/rot activations; falls back to red/green/blue
 * and a tiny isotropic scale for plain colored point clouds. If a `frame` property
 * is present (our own exports), frameCum is rebuilt so the timeline replays. */
export function parsePly(buf: ArrayBuffer): { buffer: Uint32Array; frameCum: number[] | null } {
  const bytes = new Uint8Array(buf);
  const header = new TextDecoder("ascii").decode(bytes.subarray(0, Math.min(bytes.length, 1 << 16)));
  const ehIdx = header.indexOf("end_header");
  if (ehIdx < 0) throw new Error("ply: no end_header");
  const dataStart = header.indexOf("\n", ehIdx) + 1;

  let format = "", count = 0;
  const props: { name: string; type: string; off: number }[] = [];
  let stride = 0, inVertex = false;
  for (const raw of header.slice(0, ehIdx).split(/\r?\n/)) {
    const t = raw.trim().split(/\s+/);
    if (t[0] === "format") format = t[1];
    else if (t[0] === "element") { inVertex = t[1] === "vertex"; if (inVertex) count = parseInt(t[2]); }
    else if (t[0] === "property" && inVertex) {
      if (t[1] === "list") throw new Error("ply: list property in vertex not supported");
      props.push({ name: t[2], type: t[1], off: stride });
      stride += TYPE_SIZE[t[1]] ?? 0;
    }
  }
  if (format !== "binary_little_endian") throw new Error(`ply: only binary_little_endian (got ${format || "?"})`);
  if (!count) throw new Error("ply: no vertices");

  const byName = new Map(props.map((p) => [p.name, p]));
  const dv = new DataView(buf, dataStart);
  const get = (rec: number, name: string): number | null => {
    const p = byName.get(name);
    return p ? readType(dv, rec * stride + p.off, p.type) : null;
  };
  const has = (name: string) => byName.has(name);

  const centers = new Float32Array(count * 3);
  const scales = new Float32Array(count * 3);
  const wxyz = new Float32Array(count * 4);
  const rgb = new Float32Array(count * 3);
  const opacity = new Float32Array(count);
  const hasSH = has("f_dc_0"), hasRGB = has("red"), hasScale = has("scale_0"), hasRot = has("rot_0"), hasOp = has("opacity");
  const hasFrame = has("frame");
  const frameOf = hasFrame ? new Uint16Array(count) : null;

  for (let i = 0; i < count; i++) {
    centers[i * 3] = get(i, "x")!; centers[i * 3 + 1] = get(i, "y")!; centers[i * 3 + 2] = get(i, "z")!;
    for (let k = 0; k < 3; k++) {
      const c = hasSH ? 0.5 + SH_C0 * get(i, `f_dc_${k}`)! : hasRGB ? get(i, ["red", "green", "blue"][k])! / 255 : 0.5;
      rgb[i * 3 + k] = c < 0 ? 0 : c > 1 ? 1 : c;
    }
    opacity[i] = hasOp ? sigmoid(get(i, "opacity")!) : 1;
    if (hasScale) for (let k = 0; k < 3; k++) scales[i * 3 + k] = Math.exp(get(i, `scale_${k}`)!);
    else scales[i * 3] = scales[i * 3 + 1] = scales[i * 3 + 2] = 0.01; // ponytail: point cloud -> tiny splats
    if (hasRot) for (let k = 0; k < 4; k++) wxyz[i * 4 + k] = get(i, `rot_${k}`)!;
    else wxyz[i * 4] = 1; // identity
    if (frameOf) frameOf[i] = get(i, "frame")!;
  }

  // Rebuild cumulative per-frame counts (vertices are stored in frame order).
  let frameCum: number[] | null = null;
  if (frameOf) {
    let maxF = 0;
    for (let i = 0; i < count; i++) if (frameOf[i] > maxF) maxF = frameOf[i];
    const per = new Array(maxF + 1).fill(0);
    for (let i = 0; i < count; i++) per[frameOf[i]]++;
    frameCum = [];
    let acc = 0;
    for (let f = 0; f <= maxF; f++) { acc += per[f]; frameCum.push(acc); }
  }

  const covTriu = covarianceFromScaleRotation(scales, wxyz, count);
  return { buffer: packSplats(count, centers, covTriu, rgb, opacity, false, false), frameCum };
}
