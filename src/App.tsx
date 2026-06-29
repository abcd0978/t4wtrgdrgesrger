import React from "react";
import * as THREE from "three";
import { Canvas, useThree } from "@react-three/fiber";
import { OrbitControls, TransformControls } from "@react-three/drei";
import { SplatRenderContext, SplatObject } from "./splat/GaussianSplats";
import { getDeltaManifest, getAddedNpz, getSnapshot, getRuns, type RunInfo } from "./lib/gaussianApi";
import { unzipNpz, npzToPacked } from "./lib/pack";
import { RenderSettings, DEFAULT_SETTINGS, RenderSettingsContext } from "./RenderSettings";

interface Bounds { min: [number, number, number]; max: [number, number, number]; }
interface DragRect { x0: number; y0: number; x1: number; y1: number }

function computeBounds(buffer: Uint32Array): Bounds {
  const n = buffer.length / 8;
  const dv = new DataView(buffer.buffer);
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++) {
    const b = i * 32;
    if (dv.getUint8(b + 31) === 0) continue;
    for (let k = 0; k < 3; k++) {
      const v = dv.getFloat32(b + k * 4, true);
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  }
  if (!isFinite(min[0])) return { min: [0, 0, 0], max: [1, 1, 1] };
  return { min, max };
}

const center = (b: Bounds): [number, number, number] =>
  [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
const radius = (b: Bounds): number =>
  Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2], 1) * 0.5;

function selCenter(buffer: Uint32Array, selection: Set<number>): [number, number, number] {
  const dv = new DataView(buffer.buffer);
  let x = 0, y = 0, z = 0;
  for (const i of selection) {
    x += dv.getFloat32(i * 32, true); y += dv.getFloat32(i * 32 + 4, true); z += dv.getFloat32(i * 32 + 8, true);
  }
  const n = selection.size || 1;
  return [x / n, y / n, z / n];
}

function FitCamera({ bounds }: { bounds: Bounds }) {
  const camera = useThree((s) => s.camera);
  const controls = useThree((s) => s.controls) as
    | { target: { set: (x: number, y: number, z: number) => void }; update: () => void } | null;
  const fitted = React.useRef(false);
  React.useEffect(() => {
    if (fitted.current) return;
    fitted.current = true;
    const c = center(bounds), r = radius(bounds), d = r * 2.5 + 1;
    camera.up.set(0, 0, 1);
    camera.position.set(c[0] + d, c[1] - d, c[2] + d);
    camera.near = Math.max(r * 0.001, 0.001);
    camera.far = r * 5000 + 1000;
    camera.updateProjectionMatrix();
    if (controls?.target) { controls.target.set(c[0], c[1], c[2]); controls.update(); }
    else camera.lookAt(c[0], c[1], c[2]);
  }, [bounds, camera, controls]);
  return null;
}

interface GridOpts { color: string; divisions: number; dashSize: number; gapSize: number; }

function DashedGrid({ bounds, opts }: { bounds: Bounds; opts: GridOpts }) {
  const ref = React.useRef<THREE.LineSegments>(null);
  const geo = React.useMemo(() => {
    const c = center(bounds);
    const z = bounds.min[2];
    const span = Math.max(bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1], 1) * 1.6;
    const div = Math.max(2, Math.round(opts.divisions)), step = span / div, half = span / 2;
    const pts: number[] = [];
    for (let i = 0; i <= div; i++) {
      const o = -half + i * step;
      pts.push(c[0] + o, c[1] - half, z, c[0] + o, c[1] + half, z);
      pts.push(c[0] - half, c[1] + o, z, c[0] + half, c[1] + o, z);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
    return g;
  }, [bounds, opts.divisions]);
  React.useEffect(() => { ref.current?.computeLineDistances(); }, [geo]);
  return (
    <lineSegments ref={ref} geometry={geo}>
      <lineDashedMaterial color={opts.color} dashSize={opts.dashSize} gapSize={opts.gapSize} transparent opacity={0.7} />
    </lineSegments>
  );
}

/** Double-click = single pick; double-click + drag = box select. Plain drag = camera. */
function InputController({
  bufferRef, selectionRef, setSelection, setDrag, setSelecting,
}: {
  bufferRef: React.MutableRefObject<Uint32Array | null>;
  selectionRef: React.MutableRefObject<Set<number>>;
  setSelection: (s: Set<number>) => void;
  setDrag: (d: DragRect | null) => void;
  setSelecting: (b: boolean) => void;
}) {
  const gl = useThree((s) => s.gl);
  const camera = useThree((s) => s.camera);
  const size = useThree((s) => s.size);
  const env = React.useRef({ camera, w: size.width, h: size.height });
  env.current = { camera, w: size.width, h: size.height };

  React.useEffect(() => {
    const el = gl.domElement;
    let lastUp = 0, lx = 0, ly = 0, sel = false, sx = 0, sy = 0;

    function pick(x0: number, y0: number, x1: number, y1: number, additive: boolean, single: boolean) {
      const buffer = bufferRef.current;
      if (!buffer) return;
      const { camera, w, h } = env.current;
      const dv = new DataView(buffer.buffer);
      const n = buffer.length / 8;
      const v = new THREE.Vector3();
      const out = additive ? new Set(selectionRef.current) : new Set<number>();
      if (single) {
        let best = -1, bestD = 400; // 20px radius²
        for (let i = 0; i < n; i++) {
          const b = i * 32; if (dv.getUint8(b + 31) === 0) continue;
          v.set(dv.getFloat32(b, true), dv.getFloat32(b + 4, true), dv.getFloat32(b + 8, true)).project(camera);
          if (v.z < -1 || v.z > 1) continue;
          const px = (v.x * 0.5 + 0.5) * w, py = (-v.y * 0.5 + 0.5) * h;
          const d = (px - x0) ** 2 + (py - y0) ** 2;
          if (d < bestD) { bestD = d; best = i; }
        }
        if (best >= 0) out.add(best);
      } else {
        const minX = Math.min(x0, x1), maxX = Math.max(x0, x1), minY = Math.min(y0, y1), maxY = Math.max(y0, y1);
        for (let i = 0; i < n; i++) {
          const b = i * 32; if (dv.getUint8(b + 31) === 0) continue;
          v.set(dv.getFloat32(b, true), dv.getFloat32(b + 4, true), dv.getFloat32(b + 8, true)).project(camera);
          if (v.z < -1 || v.z > 1) continue;
          const px = (v.x * 0.5 + 0.5) * w, py = (-v.y * 0.5 + 0.5) * h;
          if (px >= minX && px <= maxX && py >= minY && py <= maxY) out.add(i);
        }
      }
      setSelection(out);
    }

    const down = (e: PointerEvent) => {
      const now = performance.now();
      if (now - lastUp < 300 && Math.hypot(e.clientX - lx, e.clientY - ly) < 12) {
        // double-click: enter select drag, block camera
        sel = true; sx = e.clientX; sy = e.clientY;
        setSelecting(true);
        setDrag({ x0: sx, y0: sy, x1: sx, y1: sy });
        e.stopPropagation(); e.preventDefault();
      }
    };
    const move = (e: PointerEvent) => { if (sel) setDrag({ x0: sx, y0: sy, x1: e.clientX, y1: e.clientY }); };
    const up = (e: PointerEvent) => {
      if (sel) {
        const dist = Math.hypot(e.clientX - sx, e.clientY - sy);
        pick(sx, sy, e.clientX, e.clientY, e.shiftKey, dist < 5);
        sel = false; setSelecting(false); setDrag(null);
      }
      lastUp = performance.now(); lx = e.clientX; ly = e.clientY;
    };
    el.addEventListener("pointerdown", down, true);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      el.removeEventListener("pointerdown", down, true);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [gl, bufferRef, selectionRef, setSelection, setDrag, setSelecting]);
  return null;
}

/** Translate gizmo for the current selection; commits delta on release. */
function MoveGizmo({
  selection, buffer, onCommit,
}: {
  selection: Set<number>; buffer: Uint32Array | null; onCommit: (dx: number, dy: number, dz: number) => void;
}) {
  const gref = React.useRef<THREE.Group>(null);
  const start = React.useRef(new THREE.Vector3());
  React.useEffect(() => {
    if (gref.current && buffer && selection.size > 0) {
      const c = selCenter(buffer, selection);
      gref.current.position.set(c[0], c[1], c[2]);
    }
  }, [selection, buffer]);
  if (!buffer || selection.size === 0) return null;
  return (
    <TransformControls
      mode="translate"
      onMouseDown={() => { if (gref.current) start.current.copy(gref.current.position); }}
      onMouseUp={() => {
        if (!gref.current) return;
        const p = gref.current.position;
        onCommit(p.x - start.current.x, p.y - start.current.y, p.z - start.current.z);
      }}
    >
      <group ref={gref} />
    </TransformControls>
  );
}

function NumSlider({
  label, k, min, max, step, settings, setSettings,
}: {
  label: string; k: keyof RenderSettings; min: number; max: number; step: number;
  settings: RenderSettings; setSettings: React.Dispatch<React.SetStateAction<RenderSettings>>;
}) {
  return (
    <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12 }}>
      <span style={{ width: 84 }}>{label}</span>
      <input type="range" min={min} max={max} step={step} value={settings[k]}
        onChange={(e) => setSettings((s) => ({ ...s, [k]: parseFloat(e.target.value) }))} style={{ flex: 1 }} />
      <span style={{ width: 46, textAlign: "right" }}>{settings[k]}</span>
    </label>
  );
}

export default function App() {
  const [host, setHost] = React.useState("");
  const [runId, setRunId] = React.useState("online-3dgs-desk-20260624-spnet-gated-full-r2-deltas");
  const [runs, setRuns] = React.useState<RunInfo[]>([]);
  const [mode, setMode] = React.useState<"snapshot" | "delta">("snapshot");
  const [maxFrames, setMaxFrames] = React.useState("100");
  const [buffer, setBuffer] = React.useState<Uint32Array | null>(null);
  const [bounds, setBounds] = React.useState<Bounds | null>(null);
  const [status, setStatus] = React.useState("idle");
  const [busy, setBusy] = React.useState(false);

  const [settings, setSettings] = React.useState<RenderSettings>(DEFAULT_SETTINGS);
  const [showPanel, setShowPanel] = React.useState(false);
  const [bg, setBg] = React.useState("#ffffff");
  const [showGrid, setShowGrid] = React.useState(true);
  const [grid, setGrid] = React.useState<GridOpts>({ color: "#999999", divisions: 20, dashSize: 0.25, gapSize: 0.18 });
  const [dpr, setDpr] = React.useState(1.5);
  const [showAxes, setShowAxes] = React.useState(false);

  // selection
  const [selection, setSelection] = React.useState<Set<number>>(new Set());
  const [drag, setDrag] = React.useState<DragRect | null>(null);
  const [selecting, setSelecting] = React.useState(false);
  const bufferRef = React.useRef<Uint32Array | null>(null);
  const selectionRef = React.useRef<Set<number>>(selection);
  bufferRef.current = buffer;
  selectionRef.current = selection;

  React.useEffect(() => { getRuns(host).then(setRuns).catch(() => setRuns([])); }, [host]);

  async function load() {
    setBusy(true); setBuffer(null); setBounds(null); setSelection(new Set());
    try {
      if (mode === "snapshot") {
        setStatus("fetching snapshot…");
        const merged = npzToPacked(await unzipNpz(await getSnapshot(host, runId)));
        setBuffer(merged); setBounds(computeBounds(merged));
        setStatus(`done: ${merged.length / 8} gaussians`);
      } else {
        setStatus("fetching manifest…");
        const manifest = await getDeltaManifest(host, runId);
        const limit = Math.min(manifest.frames.length, parseInt(maxFrames) || manifest.frames.length);
        const total = manifest.frames[limit - 1]?.cumulative_gaussian_count ?? 0;
        const capacity = new Uint32Array(total * 8);
        let offset = 0;
        const updateEvery = Math.max(1, Math.floor(limit / 20));
        for (let i = 0; i < limit; i++) {
          const f = manifest.frames[i];
          const p = npzToPacked(await unzipNpz(await getAddedNpz(host, runId, f.frame_index)));
          if (offset + p.length <= capacity.length) { capacity.set(p, offset); offset += p.length; }
          if ((i + 1) % updateEvery === 0 || i === limit - 1) {
            setBuffer(capacity.subarray());
            setBounds(computeBounds(capacity.subarray(0, offset)));
            setStatus(`streaming ${i + 1}/${limit} — ${offset / 8} gaussians`);
            await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null))));
          }
        }
      }
    } catch (e) {
      setStatus("error: " + (e as Error).message);
    } finally { setBusy(false); }
  }

  const shownBuffer = React.useMemo(() => {
    if (!buffer || selection.size === 0) return buffer;
    const hb = buffer.slice();
    const dv = new DataView(hb.buffer);
    for (const i of selection) { dv.setUint8(i * 32 + 28, 255); dv.setUint8(i * 32 + 29, 90); dv.setUint8(i * 32 + 30, 0); }
    return hb;
  }, [buffer, selection]);

  function commitMove(dx: number, dy: number, dz: number) {
    if (!buffer || (dx === 0 && dy === 0 && dz === 0)) return;
    const nb = buffer.slice();
    const dv = new DataView(nb.buffer);
    for (const i of selection) {
      dv.setFloat32(i * 32, dv.getFloat32(i * 32, true) + dx, true);
      dv.setFloat32(i * 32 + 4, dv.getFloat32(i * 32 + 4, true) + dy, true);
      dv.setFloat32(i * 32 + 8, dv.getFloat32(i * 32 + 8, true) + dz, true);
    }
    setBuffer(nb); setBounds(computeBounds(nb));
  }

  const inputStyle: React.CSSProperties = { padding: 4 };

  return (
    <div style={{ position: "fixed", inset: 0 }}>
      <div style={{
        position: "absolute", zIndex: 3, top: 0, left: 0, right: 0,
        display: "flex", gap: 6, padding: 8, alignItems: "center", flexWrap: "wrap",
        background: "rgba(0,0,0,0.65)", color: "#fff", font: "13px monospace",
      }}>
        <input value={host} onChange={(e) => setHost(e.target.value)} placeholder="(empty = this server)" style={{ ...inputStyle, flex: 1, minWidth: 110 }} />
        <select value={runId} onChange={(e) => setRunId(e.target.value)} style={{ ...inputStyle, flex: 2, minWidth: 160 }}>
          {runs.length === 0 && <option value={runId}>{runId}</option>}
          {runs.map((r) => <option key={r.runId} value={r.runId}>{r.runId} ({r.gaussians})</option>)}
        </select>
        <select value={mode} onChange={(e) => setMode(e.target.value as "snapshot" | "delta")} style={inputStyle}>
          <option value="snapshot">snapshot</option>
          <option value="delta">delta</option>
        </select>
        {mode === "delta" && <input value={maxFrames} onChange={(e) => setMaxFrames(e.target.value)} title="max delta frames" style={{ ...inputStyle, width: 55 }} />}
        <button onClick={load} disabled={busy} style={{ padding: "4px 12px" }}>{busy ? "…" : "Load"}</button>
        {selection.size > 0 && <button onClick={() => setSelection(new Set())} style={{ padding: "4px 8px" }}>clear ({selection.size})</button>}
        <button onClick={() => setShowPanel((v) => !v)} style={{ padding: "4px 10px" }}>⚙</button>
        <span style={{ flex: 2, minWidth: 90 }} title="double-click to pick, double-click+drag to box-select">{status}</span>
      </div>

      {showPanel && (
        <div style={{
          position: "absolute", zIndex: 3, top: 46, right: 8, width: 280,
          display: "flex", flexDirection: "column", gap: 6, padding: 10,
          background: "rgba(0,0,0,0.78)", color: "#fff", font: "12px monospace", borderRadius: 6,
          maxHeight: "85vh", overflowY: "auto",
        }}>
          <b>shader</b>
          <NumSlider label="splat size" k="splatScale" min={0.1} max={5} step={0.1} settings={settings} setSettings={setSettings} />
          <NumSlider label="min px" k="minSplatPx" min={0} max={20} step={0.5} settings={settings} setSettings={setSettings} />
          <NumSlider label="max px" k="maxSplatPx" min={16} max={2048} step={16} settings={settings} setSettings={setSettings} />
          <NumSlider label="blur" k="blur" min={0} max={2} step={0.05} settings={settings} setSettings={setSettings} />
          <NumSlider label="opacity" k="opacityScale" min={0} max={3} step={0.05} settings={settings} setSettings={setSettings} />
          <NumSlider label="cull" k="cullThreshold" min={0} max={1} step={0.01} settings={settings} setSettings={setSettings} />
          <NumSlider label="falloff" k="falloffCutoff" min={1} max={9} step={0.25} settings={settings} setSettings={setSettings} />
          <NumSlider label="alphaTest" k="alphaTest" min={0} max={0.5} step={0.01} settings={settings} setSettings={setSettings} />
          <NumSlider label="fade" k="fadeSpeed" min={0.1} max={10} step={0.1} settings={settings} setSettings={setSettings} />
          <b>scene</b>
          <label style={{ display: "flex", gap: 6, alignItems: "center" }}><span style={{ width: 84 }}>background</span><input type="color" value={bg} onChange={(e) => setBg(e.target.value)} /></label>
          <label style={{ display: "flex", gap: 6, alignItems: "center" }}><input type="checkbox" checked={showGrid} onChange={(e) => setShowGrid(e.target.checked)} /> grid <input type="color" value={grid.color} onChange={(e) => setGrid((g) => ({ ...g, color: e.target.value }))} /></label>
          <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12 }}><span style={{ width: 84 }}>grid div</span><input type="range" min={2} max={60} step={1} value={grid.divisions} onChange={(e) => setGrid((g) => ({ ...g, divisions: parseInt(e.target.value) }))} style={{ flex: 1 }} /><span style={{ width: 46, textAlign: "right" }}>{grid.divisions}</span></label>
          <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12 }}><span style={{ width: 84 }}>dash/gap</span><input type="range" min={0.02} max={1} step={0.02} value={grid.dashSize} onChange={(e) => setGrid((g) => ({ ...g, dashSize: parseFloat(e.target.value) }))} style={{ flex: 1 }} /><input type="range" min={0.02} max={1} step={0.02} value={grid.gapSize} onChange={(e) => setGrid((g) => ({ ...g, gapSize: parseFloat(e.target.value) }))} style={{ flex: 1 }} /></label>
          <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12 }}><span style={{ width: 84 }}>DPR</span><input type="range" min={0.5} max={3} step={0.25} value={dpr} onChange={(e) => setDpr(parseFloat(e.target.value))} style={{ flex: 1 }} /><span style={{ width: 46, textAlign: "right" }}>{dpr}</span></label>
          <label style={{ display: "flex", gap: 6, alignItems: "center" }}><input type="checkbox" checked={showAxes} onChange={(e) => setShowAxes(e.target.checked)} /> axes (XYZ)</label>
          <button onClick={() => setSettings(DEFAULT_SETTINGS)} style={{ padding: "4px 8px", marginTop: 4 }}>reset shader</button>
        </div>
      )}

      {drag && (
        <div style={{
          position: "absolute", zIndex: 2, pointerEvents: "none",
          left: Math.min(drag.x0, drag.x1), top: Math.min(drag.y0, drag.y1),
          width: Math.abs(drag.x1 - drag.x0), height: Math.abs(drag.y1 - drag.y0),
          border: "1px solid #ff8800", background: "rgba(255,136,0,0.15)",
        }} />
      )}

      <Canvas dpr={dpr} camera={{ position: [5, -5, 5], up: [0, 0, 1], near: 0.01, far: 1000 }}>
        <color attach="background" args={[bg]} />
        <OrbitControls makeDefault enabled={!selecting} />
        <InputController bufferRef={bufferRef} selectionRef={selectionRef} setSelection={setSelection} setDrag={setDrag} setSelecting={setSelecting} />
        {showAxes && bounds && <axesHelper args={[radius(bounds)]} />}
        {buffer && selection.size > 0 && <MoveGizmo selection={selection} buffer={buffer} onCommit={commitMove} />}
        <RenderSettingsContext.Provider value={settings}>
          {showGrid && bounds && <DashedGrid bounds={bounds} opts={grid} />}
          {shownBuffer && bounds && (
            <>
              <FitCamera bounds={bounds} />
              <SplatRenderContext>
                <SplatObject buffer={shownBuffer} />
              </SplatRenderContext>
            </>
          )}
        </RenderSettingsContext.Provider>
      </Canvas>
    </div>
  );
}
