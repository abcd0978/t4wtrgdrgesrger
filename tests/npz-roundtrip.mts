// Self-check: makeNpz/npyBytes -> unzipNpz round-trips arrays. Run: npx tsx tests/npz-roundtrip.mts
import { makeNpz, npyBytes } from "../src/lib/npzWrite.ts";
import { unzipNpz } from "../src/lib/npz.ts";

const mean = new Float32Array([0, 0, 0, 1.5, -2, 3, -1, 0.25, 2]); // (3,3)
const frame = new Int32Array([0, 0, 1]);

const blob = makeNpz([
  { name: "mean_xyz.npy", bytes: npyBytes("<f4", [3, 3], mean) },
  { name: "source_frame_index.npy", bytes: npyBytes("<i4", [3], frame) },
]);
const back = await unzipNpz(await blob.arrayBuffer());

const m = back["mean_xyz"], f = back["source_frame_index"];
if (!m || m.shape.join(",") !== "3,3") throw new Error(`mean shape wrong: ${m?.shape}`);
let err = 0;
for (let i = 0; i < mean.length; i++) err = Math.max(err, Math.abs((m.data as Float32Array)[i] - mean[i]));
if (err > 0) throw new Error(`mean mismatch ${err}`);
if (!f || [...(f.data as Int32Array)].join(",") !== "0,0,1") throw new Error(`frame mismatch: ${f?.data}`);
console.log("npz round-trip: PASS");
