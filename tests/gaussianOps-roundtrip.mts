/** Behaviour lock for the extracted pure kernels in src/lib/gaussianOps.ts.
 * Builds a tiny synthetic packed buffer and checks each op against hand-computed
 * expectations, so a future refactor can't silently change semantics. */
import {
  buildDisplayBuffer, subsampleForLod, lodStride, cropOutside, keepOnly,
  duplicateSelection, detectFloaters, deleteIndices, invertSelection,
  growSelection, colorFilterSelection, opacityFilterSelection, selectByPosition,
  frameArray, computeSceneStats, rotateSceneBuffer,
} from "../src/lib/gaussianOps.ts";
import { computeBounds } from "../src/lib/bounds.ts";

let failures = 0;
const ok = (cond: boolean, msg: string) => { if (!cond) { failures++; console.log("  ✗ " + msg); } };

/** Build an N-gaussian buffer; `set(i,x,y,z,r,g,b,a)` writes one. */
function makeBuffer(n: number) {
  const buf = new Uint32Array(n * 8);
  const dv = new DataView(buf.buffer);
  const set = (i: number, x: number, y: number, z: number, r = 10, g = 20, b = 30, a = 255) => {
    const o = i * 32;
    dv.setFloat32(o, x, true); dv.setFloat32(o + 4, y, true); dv.setFloat32(o + 8, z, true);
    dv.setUint8(o + 28, r); dv.setUint8(o + 29, g); dv.setUint8(o + 30, b); dv.setUint8(o + 31, a);
  };
  const alpha = (i: number) => dv.getUint8(i * 32 + 31);
  const pos = (i: number): [number, number, number] => [dv.getFloat32(i * 32, true), dv.getFloat32(i * 32 + 4, true), dv.getFloat32(i * 32 + 8, true)];
  const rgb = (i: number): [number, number, number] => [dv.getUint8(i * 32 + 28), dv.getUint8(i * 32 + 29), dv.getUint8(i * 32 + 30)];
  return { buf, dv, set, alpha, pos, rgb };
}

// --- buildDisplayBuffer: no overlay returns the same reference ---
{
  const { buf, set } = makeBuffer(3);
  set(0, 0, 0, 0); set(1, 1, 0, 0); set(2, 2, 0, 0);
  const same = buildDisplayBuffer(buf, new Set(), { mode: "all", set: new Set() }, null, 0, new Set());
  ok(same === buf, "displayBuffer: identity fast-path returns same reference");

  // selection recolours to the orange highlight (255,90,0) on a copy
  const hl = buildDisplayBuffer(buf, new Set([1]), { mode: "all", set: new Set() }, null, 0, new Set());
  const d = new DataView(hl.buffer);
  ok(hl !== buf, "displayBuffer: selection produces a copy");
  ok(d.getUint8(1 * 32 + 28) === 255 && d.getUint8(1 * 32 + 29) === 90 && d.getUint8(1 * 32 + 30) === 0, "displayBuffer: selected gaussian is highlighted orange");
  ok(new DataView(buf.buffer).getUint8(1 * 32 + 28) === 10, "displayBuffer: original buffer untouched");

  // isolate hides everything not in the set
  const iso = buildDisplayBuffer(buf, new Set(), { mode: "isolate", set: new Set([0]) }, null, 0, new Set());
  const di = new DataView(iso.buffer);
  ok(di.getUint8(0 * 32 + 31) === 255 && di.getUint8(1 * 32 + 31) === 0 && di.getUint8(2 * 32 + 31) === 0, "displayBuffer: isolate hides the rest");
}

// --- subsampleForLod / lodStride ---
{
  ok(lodStride(1) === 1 && lodStride(0.5) === 2 && lodStride(0.25) === 4, "lodStride: fraction -> stride");
  const { buf } = makeBuffer(8);
  ok(subsampleForLod(buf, 1) === buf, "subsampleForLod: stride 1 returns same reference");
  ok(subsampleForLod(buf, 0.5).length === 4 * 8, "subsampleForLod: half keeps every 2nd");
}

// --- cropOutside ---
{
  const { buf, alpha } = makeBuffer(3);
  const dv = new DataView(buf.buffer);
  const put = (i: number, x: number) => { dv.setFloat32(i * 32, x, true); dv.setUint8(i * 32 + 31, 255); };
  put(0, -5); put(1, 0); put(2, 5);
  const { buffer: nb, deleted } = cropOutside(buf, [-1, -100, -100], [1, 100, 100]);
  ok(deleted === 2, "cropOutside: two of three outside the X band");
  const d = new DataView(nb.buffer);
  ok(d.getUint8(0 * 32 + 31) === 0 && d.getUint8(1 * 32 + 31) === 255 && d.getUint8(2 * 32 + 31) === 0, "cropOutside: keeps the inside one");
  ok(alpha(0) === 255, "cropOutside: input buffer not mutated");
}

// --- keepOnly ---
{
  const { buf, set } = makeBuffer(4);
  for (let i = 0; i < 4; i++) set(i, i, 0, 0);
  const { buffer: nb, deleted } = keepOnly(buf, new Set([1, 3]));
  ok(deleted === 2, "keepOnly: deletes the non-selected live gaussians");
  const d = new DataView(nb.buffer);
  ok(d.getUint8(1 * 32 + 31) === 255 && d.getUint8(3 * 32 + 31) === 255 && d.getUint8(0 * 32 + 31) === 0, "keepOnly: keeps only the selection");
}

// --- duplicateSelection ---
{
  const { buf } = makeBuffer(2);
  const dv = new DataView(buf.buffer);
  dv.setFloat32(0, 1, true); dv.setUint8(31, 255);
  const { buffer: nb, newSel } = duplicateSelection(buf, new Set([0]), 0.5);
  ok(nb.length === 3 * 8, "duplicateSelection: appends the copy");
  ok(newSel.has(2) && newSel.size === 1, "duplicateSelection: new selection is the copy");
  ok(Math.abs(new DataView(nb.buffer).getFloat32(2 * 32, true) - 1.5) < 1e-6, "duplicateSelection: copy is X-offset");
}

// --- detectFloaters + deleteIndices ---
{
  // a dense cluster of 8 near origin + one lone floater far away
  const { buf } = makeBuffer(9);
  const dv = new DataView(buf.buffer);
  const put = (i: number, x: number, y: number, z: number) => {
    dv.setFloat32(i * 32, x, true); dv.setFloat32(i * 32 + 4, y, true); dv.setFloat32(i * 32 + 8, z, true);
    dv.setUint8(i * 32 + 31, 255);
  };
  for (let i = 0; i < 8; i++) put(i, Math.cos(i) * 0.01, Math.sin(i) * 0.01, 0);
  put(8, 100, 100, 100); // floater
  const bounds = computeBounds(buf);
  const del = detectFloaters(buf, bounds);
  ok(del.includes(8), "detectFloaters: flags the isolated floater");
  ok(!del.includes(0), "detectFloaters: keeps clustered gaussians");
  const nb = deleteIndices(buf, del);
  ok(new DataView(nb.buffer).getUint8(8 * 32 + 31) === 0, "deleteIndices: floater alpha zeroed");
}

// --- selection predicates ---
{
  const { buf } = makeBuffer(4);
  const dv = new DataView(buf.buffer);
  const put = (i: number, x: number, r: number, a: number) => {
    dv.setFloat32(i * 32, x, true); dv.setUint8(i * 32 + 28, r); dv.setUint8(i * 32 + 31, a);
  };
  put(0, 0, 255, 255); put(1, 1, 250, 255); put(2, 10, 0, 255); put(3, 0, 0, 0 /* dead */);

  ok([...invertSelection(buf, new Set([0]))].sort().join() === "1,2", "invertSelection: live, non-selected only");

  const grown = growSelection(buf, new Set([0]));
  ok(grown.has(0) && !grown.has(2), "growSelection: bbox around single point stays local");

  const col = colorFilterSelection(buf, "#ff0000", 10, new Set());
  ok(col.has(0) && col.has(1) && !col.has(2), "colorFilterSelection: near-red within tolerance");

  const op = opacityFilterSelection(buf, 200, 255, new Set());
  ok(op.has(0) && op.has(1) && op.has(2) && !op.has(3), "opacityFilterSelection: excludes the dead slot");

  const byPos = selectByPosition(buf, (x) => x > 5, new Set([1]));
  ok(byPos.has(1) && byPos.has(2) && byPos.size === 2, "selectByPosition: predicate + additive base");
}

// --- frameArray ---
{
  const { buf } = makeBuffer(5);
  ok(frameArray(buf, null) === null, "frameArray: null timeline -> null");
  const fa = frameArray(buf, [2, 5]); // frame 0 = idx 0..1, frame 1 = idx 2..4
  ok(!!fa && [...fa].join() === "0,0,1,1,1", "frameArray: cumulative counts -> per-gaussian frame");
}

// --- rotateSceneBuffer: identity R leaves live positions put ---
{
  const { buf } = makeBuffer(3);
  const dv = new DataView(buf.buffer);
  dv.setFloat32(0, 2, true); dv.setFloat32(4, 3, true); dv.setFloat32(8, 4, true); dv.setUint8(31, 255);
  dv.setUint8(1 * 32 + 31, 255); dv.setUint8(2 * 32 + 31, 255);
  const I = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const nb = rotateSceneBuffer(buf, [0, 0, 0], I);
  const d = new DataView(nb.buffer);
  ok(Math.abs(d.getFloat32(0, true) - 2) < 1e-5 && Math.abs(d.getFloat32(4, true) - 3) < 1e-5 && Math.abs(d.getFloat32(8, true) - 4) < 1e-5, "rotateSceneBuffer: identity keeps positions");
}

// --- computeSceneStats ---
{
  const { buf } = makeBuffer(10);
  const dv = new DataView(buf.buffer);
  for (let i = 0; i < 10; i++) dv.setUint8(i * 32 + 31, i < 7 ? 255 : 0); // 7 live, 3 dead
  const bounds = computeBounds(buf);
  const st = computeSceneStats(buf, bounds);
  ok(st.live === 7 && st.slots === 10, "computeSceneStats: live vs slot counts");
  ok(st.opHist.length === 24 && st.sizeHist.length === 24, "computeSceneStats: 24-bin histograms");
}

if (failures) { console.log(`gaussianOps: ${failures} FAIL`); process.exit(1); }
console.log("gaussianOps kernel: PASS");
