// Self-check for the gaussian covariance math (mathUtils).
// Run: npx tsx tests/cov-roundtrip.mts
// scale+rot -> covariance -> scale+rot -> covariance must round-trip.
import {
  covarianceFromScaleRotation, covarianceToScaleRotation,
  rotateCovariance, scaleCovariance, rotationAboutAxis,
} from "../src/lib/mathUtils.ts";

const trace = (c: number[]) => c[0] + c[3] + c[5];

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

// Rotation preserves trace (sum of variances) and is reversible.
const cov = covarianceFromScaleRotation(new Float32Array([0.3, 0.1, 0.2]), new Float32Array([1, 0.2, -0.3, 0.5]), 1);
const rot = rotateCovariance([...cov], rotationAboutAxis(2, 0.6435));
if (Math.abs(trace(rot) - trace([...cov])) > 1e-5) throw new Error("rotateCovariance changed trace");
const back = rotateCovariance(rot, rotationAboutAxis(2, -0.6435));
let rotErr = 0;
for (let k = 0; k < 6; k++) rotErr = Math.max(rotErr, Math.abs(cov[k] - back[k]));
if (rotErr > 1e-5) throw new Error("rotateCovariance not reversible");

// Uniform scale s scales the trace by s².
const sc = scaleCovariance([...cov], 2, 2, 2);
if (Math.abs(trace(sc) - 4 * trace([...cov])) > 1e-5) throw new Error("scaleCovariance wrong");

console.log("PASS");
