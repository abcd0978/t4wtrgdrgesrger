// Self-check for the .splat parser (splatFile).
// Run: npx tsx tests/splat-roundtrip.mts
// Synthetic .splat records (known pos/scale/quat/color) -> splatToPacked with
// the z-up transform -> unpacked fields must match: positions (x,z,-y),
// covariance vs Rx(-90°)-rotated scale+rot (within f16 quantization), colors exact.
import { DataUtils } from "three";
import { splatToPacked } from "../src/lib/splatFile.ts";
import { covarianceFromScaleRotation } from "../src/lib/mathUtils.ts";

const N = 256;
const buf = new ArrayBuffer(N * 32);
const dv = new DataView(buf);
const rnd = (a: number, b: number) => a + Math.random() * (b - a);
const src: { p: number[]; s: number[]; q: number[]; c: number[] }[] = [];
for (let i = 0; i < N; i++) {
  const b = i * 32;
  const p = [rnd(-5, 5), rnd(-5, 5), rnd(-5, 5)];
  const s = [rnd(0.01, 0.5), rnd(0.01, 0.5), rnd(0.01, 0.5)];
  let q = [rnd(-1, 1), rnd(-1, 1), rnd(-1, 1), rnd(-1, 1)];
  const qn = Math.hypot(q[0], q[1], q[2], q[3]);
  q = q.map((v) => v / qn);
  const qu8 = q.map((v) => Math.max(0, Math.min(255, Math.round(v * 128 + 128))));
  const c = [rnd(0, 255) | 0, rnd(0, 255) | 0, rnd(0, 255) | 0, rnd(1, 255) | 0];
  p.forEach((v, k) => dv.setFloat32(b + k * 4, v, true));
  s.forEach((v, k) => dv.setFloat32(b + 12 + k * 4, v, true));
  c.forEach((v, k) => dv.setUint8(b + 24 + k, v));
  qu8.forEach((v, k) => dv.setUint8(b + 28 + k, v));
  // keep the DEQUANTIZED quat (exactly what the parser sees)
  src.push({ p, s, q: qu8.map((v) => (v - 128) / 128), c });
}

const packed = splatToPacked(buf, true);
if (packed.length !== N * 8) throw new Error("bad packed length");
const pdv = new DataView(packed.buffer);
const C = Math.SQRT1_2; // Rx(-90°) quaternion component

let maxPosErr = 0, maxCovErr = 0;
for (let i = 0; i < N; i++) {
  const b = i * 32;
  const { p, s, q, c } = src[i];
  const exp = [p[0], p[2], -p[1]]; // y-down -> z-up
  for (let k = 0; k < 3; k++) maxPosErr = Math.max(maxPosErr, Math.abs(pdv.getFloat32(b + k * 4, true) - exp[k]));
  const [w, x, y, z] = q;
  const rq = new Float32Array([C * (w + x), C * (x - w), C * (y + z), C * (z - y)]);
  const cov = covarianceFromScaleRotation(new Float32Array(s), rq, 1);
  for (let k = 0; k < 6; k++) {
    const got = DataUtils.fromHalfFloat(pdv.getUint16(b + 16 + k * 2, true));
    maxCovErr = Math.max(maxCovErr, Math.abs(got - cov[k]));
  }
  for (let k = 0; k < 3; k++) if (pdv.getUint8(b + 28 + k) !== c[k]) throw new Error("color mismatch");
  if (pdv.getUint8(b + 31) !== c[3]) throw new Error("alpha mismatch");
}
console.log("splat pos err:", maxPosErr, " cov err (f16 quant):", maxCovErr);
if (maxPosErr > 1e-6 || maxCovErr > 2e-3) throw new Error("FAIL");
console.log("PASS");
