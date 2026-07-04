/** Share/restore the FULL viewer state via URL. Everything needed for the
 * recipient to see the exact same screen goes into one base64url-encoded JSON
 * query param `z`: scene source (server run OR CDN test scene), camera,
 * selection, all render settings, and display options (background, grid,
 * DPR, LOD). Legacy multi-param links (h/r/m/f/cp/ct/s) still parse. */

export interface UrlState {
  host?: string;
  run?: string;
  mode?: "snapshot" | "delta";
  maxFrames?: string;
  test?: string; // CDN test-scene file, e.g. "train.splat"
  cam?: { p: [number, number, number]; t: [number, number, number] };
  sel?: number[];
  rs?: Record<string, unknown>; // render settings (shareable subset)
  sc?: {
    bg?: string;
    showMap?: boolean;
    showGrid?: boolean;
    grid?: { color: string; divisions: number; dashSize: number; gapSize: number };
    showAxes?: boolean;
    dprAuto?: boolean;
    dpr?: number;
    renderFrac?: number;
  };
}

const SEL_LIMIT = 500; // don't stuff huge selections into a URL

const b64e = (s: string) =>
  btoa(String.fromCharCode(...new TextEncoder().encode(s)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64d = (s: string) =>
  new TextDecoder().decode(
    Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)),
  );

const num3 = (s: string | null): [number, number, number] | undefined => {
  if (!s) return undefined;
  const a = s.split(",").map(Number);
  return a.length === 3 && a.every((x) => isFinite(x)) ? [a[0], a[1], a[2]] : undefined;
};

const vec3ok = (v: unknown): v is [number, number, number] =>
  Array.isArray(v) && v.length === 3 && v.every((x) => Number.isFinite(x));

export function readUrlState(): UrlState {
  const q = new URLSearchParams(location.search);

  // New format: everything in one packed param.
  const z = q.get("z");
  if (z) {
    try {
      const o = JSON.parse(b64d(z)) as UrlState;
      const out: UrlState = {};
      if (typeof o.host === "string") out.host = o.host;
      if (typeof o.run === "string" && o.run) out.run = o.run;
      if (o.mode === "snapshot" || o.mode === "delta") out.mode = o.mode;
      if (typeof o.maxFrames === "string") out.maxFrames = o.maxFrames;
      if (typeof o.test === "string" && /^[\w.-]+\.splat$/.test(o.test)) out.test = o.test;
      if (o.cam && vec3ok(o.cam.p) && vec3ok(o.cam.t)) out.cam = { p: o.cam.p, t: o.cam.t };
      if (Array.isArray(o.sel)) out.sel = o.sel.filter((x) => Number.isInteger(x) && x >= 0);
      if (o.rs && typeof o.rs === "object") out.rs = o.rs;
      if (o.sc && typeof o.sc === "object") out.sc = o.sc;
      return out;
    } catch { /* fall through to legacy parsing */ }
  }

  // Legacy format.
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

const r3 = (v: [number, number, number]): [number, number, number] =>
  [+v[0].toFixed(4), +v[1].toFixed(4), +v[2].toFixed(4)];

export function buildShareUrl(s: UrlState): string {
  const packed: UrlState = { ...s };
  if (packed.cam) packed.cam = { p: r3(packed.cam.p), t: r3(packed.cam.t) };
  if (packed.sel && (packed.sel.length === 0 || packed.sel.length > SEL_LIMIT)) delete packed.sel;
  for (const k of Object.keys(packed) as (keyof UrlState)[]) {
    if (packed[k] === undefined) delete packed[k];
  }
  return `${location.origin}${location.pathname}?z=${b64e(JSON.stringify(packed))}`;
}
