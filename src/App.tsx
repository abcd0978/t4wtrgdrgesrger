import React from "react";
import { Canvas } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import { SplatRenderContext, SplatObject } from "./splat/GaussianSplats";
import { getDeltaManifest, getAddedNpz, getSnapshot, getRuns, type RunInfo } from "./lib/gaussianApi";
import { unzipNpz, npzToPacked } from "./lib/pack";
import { type Bounds, computeBounds, radius } from "./lib/bounds";
import { DEFAULT_SETTINGS, RenderSettings, RenderSettingsContext } from "./RenderSettings";
import { FitCamera, DashedGrid, InputController, MoveGizmo, type GridOpts, type DragRect } from "./components/SceneObjects";
import { SettingsPanel } from "./components/SettingsPanel";

const HELP = [
  ["drag", "orbit camera"],
  ["scroll", "zoom"],
  ["double-click", "pick a gaussian"],
  ["dbl-click + drag", "box select (shift: add)"],
  ["gizmo arrows", "move selection"],
  ["undo / reset", "revert edits"],
  ["⚙", "render settings"],
];

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
  const [showHelp, setShowHelp] = React.useState(true);
  const [bg, setBg] = React.useState("#ffffff");
  const [showGrid, setShowGrid] = React.useState(true);
  const [grid, setGrid] = React.useState<GridOpts>({ color: "#999999", divisions: 20, dashSize: 0.25, gapSize: 0.18 });
  const [dpr, setDpr] = React.useState(1.5);
  const [showAxes, setShowAxes] = React.useState(false);

  // selection + editing
  const [selection, setSelection] = React.useState<Set<number>>(new Set());
  const [drag, setDrag] = React.useState<DragRect | null>(null);
  const [selecting, setSelecting] = React.useState(false);
  const [gizmoDragging, setGizmoDragging] = React.useState(false);
  const [liveBuffer, setLiveBuffer] = React.useState<Uint32Array | null>(null);
  const [undoStack, setUndoStack] = React.useState<Uint32Array[]>([]);
  const originalBuffer = React.useRef<Uint32Array | null>(null);
  const dragWork = React.useRef<{ color: Uint32Array; shown: Uint32Array } | null>(null);
  const bufferRef = React.useRef<Uint32Array | null>(null);
  const selectionRef = React.useRef<Set<number>>(selection);
  bufferRef.current = buffer;
  selectionRef.current = selection;

  React.useEffect(() => { getRuns(host).then(setRuns).catch(() => setRuns([])); }, [host]);

  async function load() {
    setBusy(true); setBuffer(null); setBounds(null); setSelection(new Set());
    setUndoStack([]); setLiveBuffer(null); originalBuffer.current = null;
    try {
      let final: Uint32Array | null = null;
      if (mode === "snapshot") {
        setStatus("fetching snapshot…");
        final = npzToPacked(await unzipNpz(await getSnapshot(host, runId)));
        setBuffer(final); setBounds(computeBounds(final));
        setStatus(`done: ${final.length / 8} gaussians`);
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
        final = capacity;
      }
      if (final) originalBuffer.current = final.slice();
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

  function onDragStart() {
    if (!buffer) return;
    setUndoStack((s) => [...s.slice(-29), buffer]);
    const color = buffer.slice();
    const shown = (shownBuffer ?? buffer).slice();
    dragWork.current = { color, shown };
    setLiveBuffer(shown.subarray());
  }
  function onDragMove(dx: number, dy: number, dz: number) {
    const w = dragWork.current;
    if (!w) return;
    for (const buf of [w.color, w.shown]) {
      const dv = new DataView(buf.buffer);
      for (const i of selection) {
        dv.setFloat32(i * 32, dv.getFloat32(i * 32, true) + dx, true);
        dv.setFloat32(i * 32 + 4, dv.getFloat32(i * 32 + 4, true) + dy, true);
        dv.setFloat32(i * 32 + 8, dv.getFloat32(i * 32 + 8, true) + dz, true);
      }
    }
    setLiveBuffer(w.shown.subarray());
  }
  function onDragEnd() {
    const w = dragWork.current;
    if (!w) return;
    setBuffer(w.color); setBounds(computeBounds(w.color));
    setLiveBuffer(null); dragWork.current = null;
  }

  function undo() {
    setUndoStack((s) => {
      if (s.length === 0) return s;
      const prev = s[s.length - 1];
      setBuffer(prev); setBounds(computeBounds(prev)); setLiveBuffer(null);
      return s.slice(0, -1);
    });
  }
  function reset() {
    const ob = originalBuffer.current;
    if (!ob) return;
    const copy = ob.slice();
    setBuffer(copy); setBounds(computeBounds(copy));
    setSelection(new Set()); setUndoStack([]); setLiveBuffer(null);
  }

  const display = liveBuffer ?? shownBuffer;
  const inputStyle: React.CSSProperties = { padding: 4 };

  return (
    <div style={{ position: "fixed", inset: 0 }}>
      <div style={{
        position: "absolute", zIndex: 3, top: 0, left: 0, right: 0,
        display: "flex", gap: 6, padding: 8, alignItems: "center", flexWrap: "wrap",
        background: "rgba(0,0,0,0.65)", color: "#fff", font: "13px monospace",
      }}>
        <input value={host} onChange={(e) => setHost(e.target.value)} placeholder="(empty = this server)" style={{ ...inputStyle, flex: 1, minWidth: 110 }} />
        <select value={runId} onChange={(e) => setRunId(e.target.value)} style={{ ...inputStyle, flex: 2, minWidth: 150 }}>
          {runs.length === 0 && <option value={runId}>{runId}</option>}
          {runs.map((r) => <option key={r.runId} value={r.runId}>{r.runId} ({r.gaussians})</option>)}
        </select>
        <select value={mode} onChange={(e) => setMode(e.target.value as "snapshot" | "delta")} style={inputStyle}>
          <option value="snapshot">snapshot</option>
          <option value="delta">delta</option>
        </select>
        {mode === "delta" && <input value={maxFrames} onChange={(e) => setMaxFrames(e.target.value)} title="max delta frames" style={{ ...inputStyle, width: 50 }} />}
        <button onClick={load} disabled={busy} style={{ padding: "4px 12px" }}>{busy ? "…" : "Load"}</button>
        <button onClick={undo} disabled={undoStack.length === 0} style={{ padding: "4px 8px" }}>undo</button>
        <button onClick={reset} disabled={!originalBuffer.current} style={{ padding: "4px 8px" }}>reset</button>
        {selection.size > 0 && <button onClick={() => setSelection(new Set())} style={{ padding: "4px 8px" }}>clear ({selection.size})</button>}
        <button onClick={() => setShowHelp((v) => !v)} style={{ padding: "4px 8px" }}>?</button>
        <button onClick={() => setShowPanel((v) => !v)} style={{ padding: "4px 10px" }}>⚙</button>
        <span style={{ flex: 2, minWidth: 80 }}>{status}</span>
      </div>

      {showPanel && (
        <SettingsPanel
          settings={settings}
          setSettings={setSettings}
          scene={{ bg, setBg, showGrid, setShowGrid, grid, setGrid, dpr, setDpr, showAxes, setShowAxes }}
        />
      )}

      {showHelp && (
        <div style={{
          position: "absolute", zIndex: 3, left: 8, bottom: 8, padding: "8px 10px",
          background: "rgba(0,0,0,0.7)", color: "#fff", font: "12px monospace", borderRadius: 6,
        }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12, marginBottom: 4 }}>
            <b>controls</b>
            <span style={{ cursor: "pointer", opacity: 0.7 }} onClick={() => setShowHelp(false)}>✕</span>
          </div>
          {HELP.map(([k, v]) => (
            <div key={k} style={{ display: "flex", gap: 10 }}>
              <span style={{ width: 110, color: "#ffb060" }}>{k}</span><span>{v}</span>
            </div>
          ))}
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
        <OrbitControls makeDefault enabled={!selecting && !gizmoDragging} />
        <InputController bufferRef={bufferRef} selectionRef={selectionRef} setSelection={setSelection} setDrag={setDrag} setSelecting={setSelecting} />
        {showAxes && bounds && <axesHelper args={[radius(bounds)]} />}
        {buffer && selection.size > 0 && (
          <MoveGizmo selection={selection} buffer={buffer} onStart={onDragStart} onMove={onDragMove} onEnd={onDragEnd} setGizmoDragging={setGizmoDragging} />
        )}
        <RenderSettingsContext.Provider value={settings}>
          {showGrid && bounds && <DashedGrid bounds={bounds} opts={grid} />}
          {display && bounds && (
            <>
              <FitCamera bounds={bounds} />
              <SplatRenderContext>
                <SplatObject buffer={display} />
              </SplatRenderContext>
            </>
          )}
        </RenderSettingsContext.Provider>
      </Canvas>
    </div>
  );
}
