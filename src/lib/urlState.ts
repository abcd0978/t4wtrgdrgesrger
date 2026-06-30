/** Share/restore viewer state via URL query: host, run, mode, max frames,
 * camera (pos+target), and a small selection. Big selections are dropped. */

export interface UrlState {
  host?: string;
  run?: string;
  mode?: "snapshot" | "delta";
  maxFrames?: string;
  cam?: { p: [number, number, number]; t: [number, number, number] };
  sel?: number[];
}

const SEL_LIMIT = 500; // don't stuff huge selections into a URL

const num3 = (s: string | null): [number, number, number] | undefined => {
  if (!s) return undefined;
  const a = s.split(",").map(Number);
  return a.length === 3 && a.every((x) => isFinite(x)) ? [a[0], a[1], a[2]] : undefined;
};

export function readUrlState(): UrlState {
  const q = new URLSearchParams(location.search);
  const out: UrlState = {};
  if (q.has("h")) out.host = q.get("h")!;
  if (q.get("r")) out.run = q.get("r")!;
  if (q.get("m") === "snapshot" || q.get("m") === "delta") out.mode = q.get("m") as UrlState["mode"];
  if (q.get("f")) out.maxFrames = q.get("f")!;
  const p = num3(q.get("cp")), t = num3(q.get("ct"));
  if (p && t) out.cam = { p, t };
  const sel = q.get("s");
  if (sel) out.sel = sel.split(",").map(Number).filter((x) => Number.isInteger(x) && x >= 0);
  return out;
}

const r3 = (v: [number, number, number]) => v.map((x) => +x.toFixed(4)).join(",");

export function buildShareUrl(s: UrlState): string {
  const q = new URLSearchParams();
  if (s.host) q.set("h", s.host);
  if (s.run) q.set("r", s.run);
  if (s.mode) q.set("m", s.mode);
  if (s.maxFrames) q.set("f", s.maxFrames);
  if (s.cam) { q.set("cp", r3(s.cam.p)); q.set("ct", r3(s.cam.t)); }
  if (s.sel && s.sel.length > 0 && s.sel.length <= SEL_LIMIT) q.set("s", s.sel.join(","));
  return `${location.origin}${location.pathname}?${q.toString()}`;
}
