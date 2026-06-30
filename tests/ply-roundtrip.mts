// Self-check for PLY export+import. Run: npx tsx tests/ply-roundtrip.mts
// packed buffer -> .ply -> parse -> packed buffer must match (centers + rgba).
import { packedToPly, parsePly } from "../src/lib/ply.ts";
import { packSplats } from "../src/lib/pack.ts";
import { covarianceFromScaleRotation } from "../src/lib/mathUtils.ts";

const n = 3;
const centers = new Float32Array([0, 0, 0, 1, 2, 3, -1, 0.5, 2]);
const scales = new Float32Array([0.1, 0.2, 0.05, 0.3, 0.1, 0.2, 0.15, 0.15, 0.15]);
const quats = new Float32Array([1, 0, 0, 0, 0.7, 0, 0.7, 0, 0.5, 0.5, 0.5, 0.5]);
const rgb = new Float32Array([0.2, 0.4, 0.6, 0.9, 0.1, 0.3, 0.5, 0.5, 0.5]); // 0..1
const op = new Float32Array([0.8, 0.5, 0.95]);

const cov = covarianceFromScaleRotation(scales, quats, n);
const packed = packSplats(n, centers, cov, rgb, op, false, false);

const ply = await packedToPly(packed).arrayBuffer();
const back = parsePly(ply);

if (back.length !== packed.length) throw new Error(`length ${back.length} != ${packed.length}`);
const a = new DataView(packed.buffer), b = new DataView(back.buffer);
let posErr = 0, rgbaErr = 0;
for (let i = 0; i < n; i++) {
  for (let k = 0; k < 3; k++) posErr = Math.max(posErr, Math.abs(a.getFloat32(i * 32 + k * 4, true) - b.getFloat32(i * 32 + k * 4, true)));
  for (let k = 28; k < 32; k++) rgbaErr = Math.max(rgbaErr, Math.abs(a.getUint8(i * 32 + k) - b.getUint8(i * 32 + k)));
}
console.log("pos err:", posErr, " rgba err (0-255):", rgbaErr);
if (posErr > 1e-4) throw new Error("PLY round-trip moved positions");
if (rgbaErr > 1) throw new Error("PLY round-trip changed color/opacity");
console.log("PASS");
