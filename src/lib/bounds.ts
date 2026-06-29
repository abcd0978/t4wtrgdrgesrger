/** Axis-aligned bounds + center/radius helpers over a packed gaussian buffer. */
export interface Bounds {
  min: [number, number, number];
  max: [number, number, number];
}

export function computeBounds(buffer: Uint32Array): Bounds {
  const n = buffer.length / 8;
  const dv = new DataView(buffer.buffer);
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++) {
    const b = i * 32;
    if (dv.getUint8(b + 31) === 0) continue; // skip empty (alpha 0) slots
    for (let k = 0; k < 3; k++) {
      const v = dv.getFloat32(b + k * 4, true);
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  }
  if (!isFinite(min[0])) return { min: [0, 0, 0], max: [1, 1, 1] };
  return { min, max };
}

export const center = (b: Bounds): [number, number, number] =>
  [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];

export const radius = (b: Bounds): number =>
  Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2], 1) * 0.5;

/** Centroid of the selected gaussians' centers. */
export function selCenter(buffer: Uint32Array, selection: Set<number>): [number, number, number] {
  const dv = new DataView(buffer.buffer);
  let x = 0, y = 0, z = 0;
  for (const i of selection) {
    x += dv.getFloat32(i * 32, true);
    y += dv.getFloat32(i * 32 + 4, true);
    z += dv.getFloat32(i * 32 + 8, true);
  }
  const n = selection.size || 1;
  return [x / n, y / n, z / n];
}
