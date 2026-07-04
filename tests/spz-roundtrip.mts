/** Synthetic .spz round-trip: encode known gaussians into an spz v2 payload
 * (gzip via node zlib), decode with spzToPacked (toZUp=false), and compare
 * position/color/alpha/covariance against directly computed values. */
import { gzipSync } from "node:zlib";
import { DataUtils } from "three";
import { spzToPacked } from "../src/lib/spz";
import { covarianceFromScaleRotation } from "../src/lib/mathUtils";

const SH_C0 = 0.28209479177387814;
const n = 3;
const fracBits = 12;
const shDegree = 1;
const shDim = 3;

// ground truth
const pos = [
  [1.25, -0.5, 3.0],
  [-2.0, 0.75, -1.5],
  [0.0, 4.0, 0.001],
];
const scaleBytes = [
  [140, 150, 160],
  [100, 110, 120],
  [160, 100, 130],
];
const rotXyz = [
  [0.1, 0.2, 0.3],
  [-0.4, 0.1, 0.2],
  [0.0, 0.0, 0.0],
];
const alpha = [255, 128, 10];
const colorBytes = [
  [200, 100, 50],
  [128, 128, 128],
  [0, 255, 30],
];
const shBytes = [ // shDim*3 = 9 bytes per point, coefficient-major rgb
  [128, 130, 126, 140, 120, 128, 100, 200, 90],
  [128, 128, 128, 128, 128, 128, 128, 128, 128],
  [0, 255, 64, 192, 32, 224, 16, 240, 8],
];

const size = 16 + n * 9 + n * 3 + n * 3 + n + n * 3 + n * shDim * 3;
const raw = new Uint8Array(size);
const dv = new DataView(raw.buffer);
dv.setUint32(0, 0x5053474e, true);
dv.setUint32(4, 2, true);
dv.setUint32(8, n, true);
raw[12] = shDegree; raw[13] = fracBits; raw[14] = 0; raw[15] = 0;

let off = 16;
const div = 1 << fracBits;
for (let i = 0; i < n; i++)
  for (let k = 0; k < 3; k++) {
    let v = Math.round(pos[i][k] * div);
    if (v < 0) v += 1 << 24;
    raw[off++] = v & 0xff; raw[off++] = (v >> 8) & 0xff; raw[off++] = (v >> 16) & 0xff;
  }
for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) raw[off++] = scaleBytes[i][k];
for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) raw[off++] = Math.round((rotXyz[i][k] + 1) * 127.5);
for (let i = 0; i < n; i++) raw[off++] = alpha[i];
for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) raw[off++] = colorBytes[i][k];
for (let i = 0; i < n; i++) for (let k = 0; k < shDim * 3; k++) raw[off++] = shBytes[i][k];

const gz = gzipSync(raw);
const { buffer, sh1 } = await spzToPacked(gz.buffer.slice(gz.byteOffset, gz.byteOffset + gz.byteLength), false);

if (buffer.length !== n * 8) throw new Error("bad length");
if (!sh1 || sh1.length !== n * 8) throw new Error("missing sh1");

const out = new DataView(buffer.buffer);
const shdv = new DataView(sh1.buffer);
let maxPosErr = 0, maxCovErr = 0, maxColErr = 0, maxShErr = 0;
const s3 = new Float32Array(3), q4 = new Float32Array(4), cov6 = new Float32Array(6);

for (let i = 0; i < n; i++) {
  const b = i * 32;
  for (let k = 0; k < 3; k++)
    maxPosErr = Math.max(maxPosErr, Math.abs(out.getFloat32(b + k * 4, true) - pos[i][k]));

  // expected covariance from the quantized bytes (decoder's own dequant path)
  for (let k = 0; k < 3; k++) s3[k] = Math.exp(scaleBytes[i][k] / 16 - 10);
  const qb = rotXyz[i].map((v) => Math.round((v + 1) * 127.5));
  const qx = qb[0] / 127.5 - 1, qy = qb[1] / 127.5 - 1, qz = qb[2] / 127.5 - 1;
  const qw = Math.sqrt(Math.max(0, 1 - qx * qx - qy * qy - qz * qz));
  q4[0] = qw; q4[1] = qx; q4[2] = qy; q4[3] = qz;
  covarianceFromScaleRotation(s3, q4, 1, cov6);
  for (let k = 0; k < 6; k++) {
    const got = DataUtils.fromHalfFloat(out.getUint16(b + 16 + k * 2, true));
    const rel = Math.abs(got - cov6[k]) / Math.max(1e-12, Math.abs(cov6[k]));
    maxCovErr = Math.max(maxCovErr, rel);
  }

  for (let ch = 0; ch < 3; ch++) {
    const fdc = (colorBytes[i][ch] / 255 - 0.5) / 0.15;
    const want = Math.round(Math.min(1, Math.max(0, 0.5 + SH_C0 * fdc)) * 255);
    maxColErr = Math.max(maxColErr, Math.abs(out.getUint8(b + 28 + ch) - want));
  }
  if (out.getUint8(b + 31) !== alpha[i]) throw new Error("alpha mismatch");

  // sh: file is coefficient-major rgb triples; side buffer channel-major
  for (let ch = 0; ch < 3; ch++)
    for (let k = 0; k < 3; k++) {
      const want = (shBytes[i][k * 3 + ch] - 128) / 128;
      const got = DataUtils.fromHalfFloat(shdv.getUint16(b + (ch * 3 + k) * 2, true));
      maxShErr = Math.max(maxShErr, Math.abs(got - want));
    }
}
console.log(`spz pos err: ${maxPosErr}  cov rel err: ${maxCovErr}  col err: ${maxColErr}  sh err: ${maxShErr}`);
if (maxPosErr > 1 / (1 << fracBits) || maxCovErr > 2e-3 || maxColErr > 1 || maxShErr > 1e-3) {
  console.log("FAIL"); process.exit(1);
}
console.log("PASS");
