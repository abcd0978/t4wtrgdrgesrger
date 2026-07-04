/** Camera-pose (position + target) clipboard formats used by the 통계 panel. */

export type Vec3 = [number, number, number];

/** Round a vector to 3 decimals and serialise as the copy-button JSON. */
export function formatCamPose(p: Vec3, t: Vec3): string {
  const r3 = (a: number[]) => a.map((v) => Math.round(v * 1000) / 1000);
  return JSON.stringify({ p: r3(p), t: r3(t) });
}

/** Parse a pasted pose. Accepts the copy-button JSON ({p:[..], t:[..]}), or
 * bare numbers: 6 = position+target, 3 = position only (target left null).
 * Returns null when no position can be recovered. */
export function parseCamPose(txt: string): { p: Vec3; t: Vec3 | null } | null {
  const s = txt.trim();
  if (!s) return null;
  const vec3 = (a: unknown): Vec3 | null =>
    Array.isArray(a) && a.length >= 3 && a.slice(0, 3).every((v) => Number.isFinite(v))
      ? [a[0], a[1], a[2]] : null;
  let p: Vec3 | null = null;
  let t: Vec3 | null = null;
  try {
    const o = JSON.parse(s);
    p = vec3(o?.p); t = vec3(o?.t);
  } catch { /* not JSON — fall through to number parsing */ }
  if (!p) {
    const nums = (s.match(/-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?/g) || []).map(Number);
    if (nums.length >= 6) { p = [nums[0], nums[1], nums[2]]; t = [nums[3], nums[4], nums[5]]; }
    else if (nums.length >= 3) p = [nums[0], nums[1], nums[2]];
  }
  return p ? { p, t } : null;
}
