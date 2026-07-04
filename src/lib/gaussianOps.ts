/** Pure compute kernels over the packed gaussian buffer.
 *
 * These functions carry NO React / DOM state: they take a buffer (and params)
 * and return a new buffer, a selection Set, or a plain-data result. App.tsx
 * wraps them with the stateful concerns (undo snapshots, setBuffer, status
 * toasts). Keeping the kernels here makes them unit-testable and keeps the
 * component focused on orchestration.
 *
 * Packed layout per gaussian (32 bytes): xyz f32 | group u32 | cov 6×f16 |
 * rgba 4×u8. Alpha 0 is the "empty/deleted" sentinel: skipped by render,
 * picking, bounds, and export. */
import { type Bounds, radius } from "./bounds";
import { rotateCovariance } from "./mathUtils";
import { hexToRgb, viewOf, readCov6, writeCov6 } from "./gaussianEdit";
import { Selection } from "./selection";

export type Vis = { mode: "all" | "hide" | "isolate"; set: Set<number> };

const ALIVE = (dv: DataView, base: number) => dv.getUint8(base + 31) !== 0;

/** Spatial-hash cell key (shared by floater removal + diff heatmap). */
const cellKey = (ix: number, iy: number, iz: number) =>
  ((ix * 73856093) ^ (iy * 19349663) ^ (iz * 83492791)) >>> 0;

// ---------------------------------------------------------------------------
// Display buffer: timeline truncation + hide/isolate + group-hide (alpha 0) +
// selection highlight (orange), overlaid on a copy so edits stay on the real
// buffer. Returns the SAME reference in the common no-overlay case so the
// renderer can skip re-upload.
// ---------------------------------------------------------------------------
export function buildDisplayBuffer(
  buffer: Uint32Array,
  selection: Selection,
  vis: Vis,
  frameCum: number[] | null,
  frameIdx: number,
  groupHiddenSet: Set<number>,
): Uint32Array {
  const scrubbing = frameCum != null && frameIdx < frameCum.length - 1;
  const frontier = scrubbing ? frameCum![frameIdx] : Infinity;
  const gHide = groupHiddenSet.size > 0;
  if (selection.size === 0 && vis.mode === "all" && !scrubbing && !gHide) return buffer;
  const hb = buffer.slice();
  const dv = new DataView(hb.buffer);
  const slots = hb.length / 8;
  if (scrubbing || vis.mode !== "all" || gHide) {
    for (let i = 0; i < slots; i++) {
      let hide = i >= frontier;
      if (vis.mode === "hide") hide = hide || vis.set.has(i);
      else if (vis.mode === "isolate") hide = hide || !vis.set.has(i);
      if (gHide && groupHiddenSet.has(i)) hide = true;
      if (hide) dv.setUint8(i * 32 + 31, 0);
    }
  }
  for (const i of selection) {
    if (i < frontier && dv.getUint8(i * 32 + 31) !== 0) {
      dv.setUint8(i * 32 + 28, 255); dv.setUint8(i * 32 + 29, 90); dv.setUint8(i * 32 + 30, 0);
    }
  }
  return hb;
}

/** LOD stride for a render fraction in (0,1]. */
export const lodStride = (renderFrac: number) =>
  renderFrac >= 1 ? 1 : Math.max(1, Math.round(1 / renderFrac));

/** Draw only every Nth gaussian when renderFrac < 1 (picking/editing keep the
 * full buffer). Returns the same reference at stride 1. */
export function subsampleForLod(buffer: Uint32Array, renderFrac: number): Uint32Array {
  const stride = lodStride(renderFrac);
  if (stride === 1) return buffer;
  const n = buffer.length / 8;
  const m = Math.floor(n / stride);
  const out = new Uint32Array(m * 8);
  for (let j = 0; j < m; j++) out.set(buffer.subarray(j * stride * 8, j * stride * 8 + 8), j * 8);
  return out;
}

/** SH side buffer subsampled with the same stride, index-aligned to what's
 * drawn. `drawnLen` is the (un-subsampled) display buffer length. */
export function subsampleShForLod(sh1: Uint32Array, drawnLen: number, renderFrac: number): Uint32Array {
  const stride = lodStride(renderFrac);
  if (stride === 1) return sh1;
  const n = drawnLen / 8;
  const m = Math.floor(n / stride);
  const out = new Uint32Array(m * 8);
  for (let j = 0; j < m; j++) {
    const src = j * stride * 8;
    if (src + 8 <= sh1.length) out.set(sh1.subarray(src, src + 8), j * 8);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Whole-buffer transforms (return a fresh buffer; caller snapshots for undo).
// ---------------------------------------------------------------------------

/** Rotate every live gaussian's position + covariance about `c` by row-major R. */
export function rotateSceneBuffer(buffer: Uint32Array, c: [number, number, number], R: number[]): Uint32Array {
  const nb = buffer.slice();
  const dv = new DataView(nb.buffer);
  const slots = nb.length / 8;
  const cov = [0, 0, 0, 0, 0, 0];
  for (let i = 0; i < slots; i++) {
    const b = i * 32;
    if (dv.getUint8(b + 31) === 0) continue;
    const px = dv.getFloat32(b, true) - c[0], py = dv.getFloat32(b + 4, true) - c[1], pz = dv.getFloat32(b + 8, true) - c[2];
    dv.setFloat32(b, c[0] + R[0] * px + R[1] * py + R[2] * pz, true);
    dv.setFloat32(b + 4, c[1] + R[3] * px + R[4] * py + R[5] * pz, true);
    dv.setFloat32(b + 8, c[2] + R[6] * px + R[7] * py + R[8] * pz, true);
    readCov6(dv, b, cov); writeCov6(dv, b, rotateCovariance(cov, R));
  }
  return nb;
}

/** Alpha-0 everything outside the [min,max] box. Returns the new buffer + count. */
export function cropOutside(buffer: Uint32Array, mn: number[], mx: number[]): { buffer: Uint32Array; deleted: number } {
  const nb = buffer.slice();
  const dv = new DataView(nb.buffer);
  const slots = nb.length / 8;
  let deleted = 0;
  for (let i = 0; i < slots; i++) {
    const b = i * 32;
    if (dv.getUint8(b + 31) === 0) continue;
    const x = dv.getFloat32(b, true), y = dv.getFloat32(b + 4, true), z = dv.getFloat32(b + 8, true);
    if (x < mn[0] || x > mx[0] || y < mn[1] || y > mx[1] || z < mn[2] || z > mx[2]) {
      dv.setUint8(b + 31, 0);
      deleted++;
    }
  }
  return { buffer: nb, deleted };
}

/** Keep ONLY the selection: alpha-0 every other live gaussian. */
export function keepOnly(buffer: Uint32Array, selection: Selection): { buffer: Uint32Array; deleted: number } {
  const nb = buffer.slice();
  const dv = new DataView(nb.buffer);
  const slots = nb.length / 8;
  let deleted = 0;
  for (let i = 0; i < slots; i++) {
    if (selection.has(i)) continue;
    const b = i * 32;
    if (dv.getUint8(b + 31) !== 0) { dv.setUint8(b + 31, 0); deleted++; }
  }
  return { buffer: nb, deleted };
}

/** Copy the selection (offset +off along X) into appended slots; the copies
 * become the new selection. */
export function duplicateSelection(buffer: Uint32Array, selection: Selection, off: number): { buffer: Uint32Array; newSel: Selection } {
  const sel = [...selection];
  const nb = new Uint32Array(buffer.length + sel.length * 8);
  nb.set(buffer);
  const dv = new DataView(nb.buffer);
  const newSel = new Selection();
  let w = buffer.length;
  for (const i of sel) {
    nb.copyWithin(w, i * 8, i * 8 + 8);
    dv.setFloat32(w * 4, dv.getFloat32(w * 4, true) + off, true);
    newSel.add(w / 8);
    w += 8;
  }
  return { buffer: nb, newSel };
}

// ---------------------------------------------------------------------------
// Floater removal: gaussians with (almost) no neighbours in a coarse spatial
// hash grid. Returns the indices to delete (caller applies + snapshots).
// ---------------------------------------------------------------------------
export function detectFloaters(buffer: Uint32Array, bounds: Bounds): number[] {
  const dv = viewOf(buffer);
  const slots = buffer.length / 8;
  const cell = Math.max(radius(bounds) / 50, 1e-9);
  const counts = new Map<number, number>();
  for (let i = 0; i < slots; i++) {
    const b = i * 32;
    if (dv.getUint8(b + 31) === 0) continue;
    const k = cellKey(
      Math.floor(dv.getFloat32(b, true) / cell),
      Math.floor(dv.getFloat32(b + 4, true) / cell),
      Math.floor(dv.getFloat32(b + 8, true) / cell),
    );
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const MIN_N = 5; // neighbours (incl. self) below this = floater
  const del: number[] = [];
  for (let i = 0; i < slots; i++) {
    const b = i * 32;
    if (dv.getUint8(b + 31) === 0) continue;
    const ix = Math.floor(dv.getFloat32(b, true) / cell);
    const iy = Math.floor(dv.getFloat32(b + 4, true) / cell);
    const iz = Math.floor(dv.getFloat32(b + 8, true) / cell);
    if ((counts.get(cellKey(ix, iy, iz)) ?? 0) > MIN_N) continue;
    let nb = 0;
    outer: for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dz = -1; dz <= 1; dz++) {
          nb += counts.get(cellKey(ix + dx, iy + dy, iz + dz)) ?? 0;
          if (nb > MIN_N) break outer;
        }
    if (nb <= MIN_N) del.push(i);
  }
  return del;
}

/** Apply an alpha-0 delete to the given indices, returning a fresh buffer. */
export function deleteIndices(buffer: Uint32Array, indices: Iterable<number>): Uint32Array {
  const nb = buffer.slice();
  const dv = new DataView(nb.buffer);
  for (const i of indices) dv.setUint8(i * 32 + 31, 0);
  return nb;
}

// ---------------------------------------------------------------------------
// Selection predicates (return a new Set of gaussian indices).
// ---------------------------------------------------------------------------

/** Every live gaussian NOT currently selected. */
export function invertSelection(buffer: Uint32Array, selection: Selection): Selection {
  const dv = viewOf(buffer);
  const n = buffer.length / 8;
  const next = new Selection();
  for (let i = 0; i < n; i++) if (dv.getUint8(i * 32 + 31) !== 0 && !selection.has(i)) next.add(i);
  return next;
}

/** Add every live gaussian inside the (5%-padded) bounding box of the current
 * selection — a cheap "fill out the region" grow. */
export function growSelection(buffer: Uint32Array, selection: Selection): Selection {
  const dv = viewOf(buffer);
  let mnx = Infinity, mny = Infinity, mnz = Infinity, mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
  for (const i of selection) {
    const b = i * 32, x = dv.getFloat32(b, true), y = dv.getFloat32(b + 4, true), z = dv.getFloat32(b + 8, true);
    if (x < mnx) mnx = x; if (y < mny) mny = y; if (z < mnz) mnz = z;
    if (x > mxx) mxx = x; if (y > mxy) mxy = y; if (z > mxz) mxz = z;
  }
  const pad = 0.05 * Math.max(mxx - mnx, mxy - mny, mxz - mnz, 1e-6);
  mnx -= pad; mny -= pad; mnz -= pad; mxx += pad; mxy += pad; mxz += pad;
  const n = buffer.length / 8;
  const next = new Selection(selection);
  for (let i = 0; i < n; i++) {
    const b = i * 32;
    if (dv.getUint8(b + 31) === 0) continue;
    const x = dv.getFloat32(b, true), y = dv.getFloat32(b + 4, true), z = dv.getFloat32(b + 8, true);
    if (x >= mnx && x <= mxx && y >= mny && y <= mxy && z >= mnz && z <= mxz) next.add(i);
  }
  return next;
}

/** Live gaussians whose RGB is within `tol` (euclidean) of `hexColor`. */
export function colorFilterSelection(buffer: Uint32Array, hexColor: string, tol: number, base: Selection): Selection {
  const [tr, tg, tb] = hexToRgb(hexColor);
  const tol2 = tol * tol;
  const dv = viewOf(buffer);
  const n = buffer.length / 8;
  const next = new Selection(base);
  for (let i = 0; i < n; i++) {
    const b = i * 32;
    if (dv.getUint8(b + 31) === 0) continue;
    const dr = dv.getUint8(b + 28) - tr, dg = dv.getUint8(b + 29) - tg, db = dv.getUint8(b + 30) - tb;
    if (dr * dr + dg * dg + db * db <= tol2) next.add(i);
  }
  return next;
}

/** Live gaussians whose u8 alpha is within [min,max]. */
export function opacityFilterSelection(buffer: Uint32Array, min: number, max: number, base: Selection): Selection {
  const lo = Math.min(min, max), hi = Math.max(min, max);
  const dv = viewOf(buffer);
  const n = buffer.length / 8;
  const next = new Selection(base);
  for (let i = 0; i < n; i++) {
    const a = dv.getUint8(i * 32 + 31);
    if (a !== 0 && a >= lo && a <= hi) next.add(i);
  }
  return next;
}

/** Live gaussians whose centre satisfies `contains` (e.g. a convex-hull test).
 * `base` seeds the result (additive select); pass an empty set to replace. */
export function selectByPosition(
  buffer: Uint32Array,
  contains: (x: number, y: number, z: number) => boolean,
  base: Selection,
): Selection {
  const dv = viewOf(buffer);
  const slots = buffer.length / 8;
  const out = new Selection(base);
  for (let i = 0; i < slots; i++) {
    const b = i * 32;
    if (dv.getUint8(b + 31) === 0) continue;
    if (contains(dv.getFloat32(b, true), dv.getFloat32(b + 4, true), dv.getFloat32(b + 8, true))) out.add(i);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Timeline + stats.
// ---------------------------------------------------------------------------

/** Per-gaussian frame index derived from cumulative counts (for replayable
 * exports). Null when there's no timeline. */
export function frameArray(buffer: Uint32Array, frameCum: number[] | null): Uint32Array | null {
  if (!frameCum) return null;
  const arr = new Uint32Array(buffer.length / 8);
  let f = 0;
  for (let i = 0; i < arr.length; i++) {
    while (f < frameCum.length - 1 && frameCum[f] <= i) f++;
    arr[i] = f;
  }
  return arr;
}

export interface SceneStats {
  live: number;
  slots: number;
  mb: number;
  size: readonly [number, number, number];
  opHist: number[];
  sizeHist: number[];
  sizeP95: number;
}

/** Live count + AABB size + opacity / splat-size distribution histograms
 * (sub-sampled). Mirrors the stats-panel scan. */
export function computeSceneStats(buffer: Uint32Array, bounds: Bounds): SceneStats {
  const dv = viewOf(buffer);
  const slots = buffer.length / 8;
  let live = 0;
  for (let i = 0; i < slots; i++) if (dv.getUint8(i * 32 + 31) !== 0) live++;
  const BINS = 24;
  const opHist = new Array<number>(BINS).fill(0);
  const sizes: number[] = [];
  const cov = [0, 0, 0, 0, 0, 0];
  const step = Math.max(1, Math.floor(slots / 200_000));
  for (let i = 0; i < slots; i += step) {
    const b = i * 32;
    const a = dv.getUint8(b + 31);
    if (a === 0) continue;
    opHist[Math.min(BINS - 1, Math.floor(((a - 1) / 255) * BINS))]++;
    readCov6(dv, b, cov);
    sizes.push(Math.sqrt(Math.max(0, (cov[0] + cov[3] + cov[5]) / 3)));
  }
  sizes.sort((x, y) => x - y);
  const sizeP95 = sizes[Math.floor(sizes.length * 0.95)] || 1e-9;
  const sizeHist = new Array<number>(BINS).fill(0);
  for (const s of sizes) sizeHist[Math.min(BINS - 1, Math.floor((s / sizeP95) * (BINS - 1)))]++;
  return {
    live, slots, mb: buffer.byteLength / 1048576,
    size: [bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1], bounds.max[2] - bounds.min[2]] as const,
    opHist, sizeHist, sizeP95,
  };
}

/** Recolour the main buffer by distance to the nearest overlay gaussian
 * (blue = coincident, red = no counterpart within 5% of scene radius). */
export function diffHeatmapColors(buffer: Uint32Array, overlay: Uint32Array, bounds: Bounds): Uint32Array {
  const cap = radius(bounds) * 0.05;
  const cell = cap;
  const bdv = viewOf(overlay);
  const bslots = overlay.length / 8;
  const bstep = Math.max(1, Math.floor(bslots / 1_000_000));
  const grid = new Map<number, number[]>();
  for (let i = 0; i < bslots; i += bstep) {
    const b = i * 32;
    if (bdv.getUint8(b + 31) === 0) continue;
    const x = bdv.getFloat32(b, true), y = bdv.getFloat32(b + 4, true), z = bdv.getFloat32(b + 8, true);
    const k = cellKey(Math.floor(x / cell), Math.floor(y / cell), Math.floor(z / cell));
    let arr = grid.get(k);
    if (!arr) grid.set(k, (arr = []));
    arr.push(x, y, z);
  }
  const nb = buffer.slice();
  const ndv = new DataView(nb.buffer);
  const slots = nb.length / 8;
  const cap2 = cap * cap;
  const near2 = cap2 * 0.01; // "close enough" early exit (10% of cap)
  for (let i = 0; i < slots; i++) {
    const b = i * 32;
    if (ndv.getUint8(b + 31) === 0) continue;
    const x = ndv.getFloat32(b, true), y = ndv.getFloat32(b + 4, true), z = ndv.getFloat32(b + 8, true);
    const ix = Math.floor(x / cell), iy = Math.floor(y / cell), iz = Math.floor(z / cell);
    let min2 = cap2;
    outer: for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dz = -1; dz <= 1; dz++) {
          const arr = grid.get(cellKey(ix + dx, iy + dy, iz + dz));
          if (!arr) continue;
          for (let j = 0; j < arr.length; j += 3) {
            const ddx = arr[j] - x, ddy = arr[j + 1] - y, ddz = arr[j + 2] - z;
            const d2 = ddx * ddx + ddy * ddy + ddz * ddz;
            if (d2 < min2) {
              min2 = d2;
              if (min2 < near2) break outer;
            }
          }
        }
    const t = Math.min(1, Math.sqrt(min2) / cap);
    ndv.setUint8(b + 28, Math.round(255 * t));
    ndv.setUint8(b + 29, Math.round(140 * (1 - Math.abs(2 * t - 1))));
    ndv.setUint8(b + 30, Math.round(255 * (1 - t)));
  }
  return nb;
}
