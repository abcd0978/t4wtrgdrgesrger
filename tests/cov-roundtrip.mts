// Self-check for the gaussian covariance math (mathUtils).
// Run: npx tsx tests/cov-roundtrip.mts
// scale+rot -> covariance -> scale+rot -> covariance must round-trip.
import { covarianceFromScaleRotation, covarianceToScaleRotation } from "../src/lib/mathUtils.ts";

const cases = [
  { s: [0.3, 0.1, 0.2], q: [1, 0.2, -0.3, 0.5] },
  { s: [1, 1, 1], q: [1, 0, 0, 0] },
  { s: [0.05, 0.5, 0.02], q: [0.3, 0.9, 0.1, -0.2] },
  { s: [0.4, 0.4, 0.01], q: [0.7, 0, 0.7, 0] },
];

let maxErr = 0;
for (const { s, q } of cases) {
  const cov = covarianceFromScaleRotation(new Float32Array(s), new Float32Array(q), 1);
  const { scale, quaternion } = covarianceToScaleRotation([...cov]);
  const cov2 = covarianceFromScaleRotation(new Float32Array(scale), new Float32Array(quaternion), 1);
  for (let k = 0; k < 6; k++) maxErr = Math.max(maxErr, Math.abs(cov[k] - cov2[k]));
}

console.log("max covariance round-trip error:", maxErr);
if (maxErr > 1e-5) throw new Error("covariance round-trip FAILED");
console.log("PASS");
