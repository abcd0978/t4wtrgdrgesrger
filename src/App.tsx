import React from "react";
import { Canvas } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import { SplatRenderContext, SplatObject } from "./splat/GaussianSplats";
import { getDeltaManifest, getAddedNpz, getSnapshot, getRuns, type RunInfo } from "./lib/gaussianApi";
import { unzipNpz, npzToPacked } from "./lib/pack";
import { type Bounds, computeBounds, radius } from "./lib/bounds";
import { DEFAULT_SETTINGS, RenderSettings, RenderSettingsContext } from "./RenderSettings";
import { FitCamera, DashedGrid, InputController, DragMoveHandle, CanvasCapture, type GridOpts, type DragRect } from "./components/SceneObjects";
import { SettingsPanel } from "./components/SettingsPanel";
import { packedToPly } from "./lib/ply";

const HELP = [
  ["드래그", "카메라 회전"],
  ["스크롤", "확대 / 축소"],
  ["더블클릭", "가우시안 1개 선택"],
  ["더블클릭 + 드래그", "박스로 여러 개 선택 (Shift: 추가)"],
  ["주황 핸들 드래그", "선택한 것 이동"],
  ["삭제 / 색·불투명도", "선택 후 왼쪽 패널"],
  ["내보내기 / 스크린샷", "상단 버튼 (.ply / .png)"],
  ["undo / reset", "되돌리기 / 처음으로"],
  ["⚙ 버튼", "렌더 설정 열기"],
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
  const [liveBuffer, setLiveBuffer] = React.useState<Uint32Array | null>(null);
  const [undoStack, setUndoStack] = React.useState<Uint32Array[]>([]);
  const [splatKey, setSplatKey] = React.useState(0); // bump to remount renderer after an edit
  const [moveStep, setMoveStep] = React.useState(0.05);
  const [editColor, setEditColor] = React.useState("#ff8800");
  const [editAlpha, setEditAlpha] = React.useState(1);
  const [showStats, setShowStats] = React.useState(false);
  const captureRef = React.useRef<((name: string) => void) | null>(null);
  const originalBuffer = React.useRef<Uint32Array | null>(null);
  const dragWork = React.useRef<{ color: Uint32Array; snap: Uint32Array } | null>(null);
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

  // One edit primitive for move/delete/recolor: snapshot for undo, copy, mutate
  // the selected gaussians, swap the ref. Same length -> renderer updates the
  // texture in place (no remount, no bounds re-scan): keeps edits snappy.
  function commitEdit(mutate: (dv: DataView, base: number) => void, msg: string) {
    if (!buffer || selection.size === 0) return;
    setUndoStack((s) => [...s.slice(-29), buffer]);
    const nb = buffer.slice();
    const dv = new DataView(nb.buffer);
    for (const i of selection) mutate(dv, i * 32);
    setBuffer(nb);
    setStatus(msg);
  }

  // Net move on release (delta = end - start). No-op moves stay free.
  function moveSelection(dx: number, dy: number, dz: number) {
    if (!dx && !dy && !dz) return;
    commitEdit((dv, b) => {
      dv.setFloat32(b, dv.getFloat32(b, true) + dx, true);
      dv.setFloat32(b + 4, dv.getFloat32(b + 4, true) + dy, true);
      dv.setFloat32(b + 8, dv.getFloat32(b + 8, true) + dz, true);
    }, `moved ${selection.size} gaussians`);
  }

  // Delete = set alpha 0 (the existing "empty slot" sentinel: skipped by render,
  // picking, bounds, and export). Reversible via undo; baked in on export.
  function deleteSelection() {
    const n = selection.size;
    commitEdit((dv, b) => dv.setUint8(b + 31, 0), `deleted ${n} gaussians`);
    setSelection(new Set());
  }

  function applyColorOpacity() {
    const r = parseInt(editColor.slice(1, 3), 16);
    const g = parseInt(editColor.slice(3, 5), 16);
    const bl = parseInt(editColor.slice(5, 7), 16);
    const a = Math.round(editAlpha * 255);
    commitEdit((dv, b) => {
      dv.setUint8(b + 28, r); dv.setUint8(b + 29, g); dv.setUint8(b + 30, bl); dv.setUint8(b + 31, a);
    }, `recolored ${selection.size} gaussians`);
  }

  const downloadBlob = React.useCallback((blob: Blob, name: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = name; a.click();
    URL.revokeObjectURL(url);
  }, []);

  function exportPly() {
    if (!buffer) return;
    downloadBlob(packedToPly(buffer), `${runId || "gaussians"}.ply`);
    setStatus("exported .ply");
  }

  const stats = React.useMemo(() => {
    if (!buffer || !bounds) return null;
    const dv = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    const slots = buffer.length / 8;
    let live = 0;
    for (let i = 0; i < slots; i++) if (dv.getUint8(i * 32 + 31) !== 0) live++;
    return {
      live, slots, mb: buffer.byteLength / 1048576,
      size: [bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1], bounds.max[2] - bounds.min[2]] as const,
    };
  }, [buffer, bounds]);

  function undo() {
    setUndoStack((s) => {
      if (s.length === 0) return s;
      const prev = s[s.length - 1];
      setBuffer(prev); setBounds(computeBounds(prev)); setLiveBuffer(null);
      setSplatKey((k) => k + 1);
      return s.slice(0, -1);
    });
  }
  function reset() {
    const ob = originalBuffer.current;
    if (!ob) return;
    const copy = ob.slice();
    setBuffer(copy); setBounds(computeBounds(copy));
    setSelection(new Set()); setUndoStack([]); setLiveBuffer(null);
    setSplatKey((k) => k + 1);
  }

  const display = liveBuffer ?? shownBuffer;
  const inputStyle: React.CSSProperties = { padding: 4 };

  return (
    <div style={{ position: "fixed", inset: 0 }}>
      <div style={{
        position: "absolute", zIndex: 3, top: 0, left: 0, right: 0,
        display: "flex", gap: 6, padding: 8, alignItems: "center", flexWrap: "wrap",
        background: "rgba(0,0,0,0.65)", color: "#fff", font: "15px monospace",
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
        <button onClick={exportPly} disabled={!buffer} style={{ padding: "4px 8px" }}>내보내기</button>
        <button onClick={() => captureRef.current?.(`${runId || "viser"}.png`)} disabled={!buffer} style={{ padding: "4px 8px" }}>스크린샷</button>
        <button onClick={() => setShowStats((v) => !v)} style={{ padding: "4px 8px" }}>통계</button>
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
          position: "absolute", zIndex: 3, left: 12, bottom: 12, padding: "16px 20px",
          background: "rgba(0,0,0,0.8)", color: "#fff", font: "16px sans-serif", borderRadius: 10,
          lineHeight: 1.8,
        }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 24, marginBottom: 10, fontSize: 20 }}>
            <b>📖 사용 방법</b>
            <span style={{ cursor: "pointer", opacity: 0.7 }} onClick={() => setShowHelp(false)}>✕</span>
          </div>
          {HELP.map(([k, v]) => (
            <div key={k} style={{ display: "flex", gap: 16 }}>
              <span style={{ width: 180, color: "#ffb060", fontWeight: 700 }}>{k}</span><span>{v}</span>
            </div>
          ))}
        </div>
      )}

      {selection.size > 0 && (
        <div style={{
          position: "absolute", zIndex: 3, top: 50, left: 8, padding: 12,
          background: "rgba(0,0,0,0.82)", color: "#fff", font: "14px monospace", borderRadius: 8,
          display: "flex", flexDirection: "column", gap: 8, width: 190,
        }}>
          <div><b>선택 {selection.size}개 이동</b></div>
          <label style={{ display: "flex", gap: 6, alignItems: "center" }}>step
            <input type="range" min={0.01} max={1} step={0.01} value={moveStep} onChange={(e) => setMoveStep(parseFloat(e.target.value))} style={{ flex: 1 }} />
            <span style={{ width: 38, textAlign: "right" }}>{moveStep}</span>
          </label>
          {([["X", 0], ["Y", 1], ["Z", 2]] as const).map(([ax, i]) => (
            <div key={ax} style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <span style={{ width: 14 }}>{ax}</span>
              <button style={{ flex: 1, padding: 6 }} onClick={() => moveSelection(i === 0 ? -moveStep : 0, i === 1 ? -moveStep : 0, i === 2 ? -moveStep : 0)}>−</button>
              <button style={{ flex: 1, padding: 6 }} onClick={() => moveSelection(i === 0 ? moveStep : 0, i === 1 ? moveStep : 0, i === 2 ? moveStep : 0)}>＋</button>
            </div>
          ))}
          <div style={{ borderTop: "1px solid #444", margin: "2px 0" }} />
          <label style={{ display: "flex", gap: 6, alignItems: "center" }}>색
            <input type="color" value={editColor} onChange={(e) => setEditColor(e.target.value)} />
            <span style={{ flex: 1 }} />
            <input type="range" min={0} max={1} step={0.01} value={editAlpha} onChange={(e) => setEditAlpha(parseFloat(e.target.value))} style={{ width: 60 }} title="불투명도" />
          </label>
          <button style={{ padding: 6 }} onClick={applyColorOpacity}>색·불투명도 적용</button>
          <button style={{ padding: 6, background: "#822", color: "#fff", border: "none", borderRadius: 4 }} onClick={deleteSelection}>삭제 ({selection.size})</button>
        </div>
      )}

      {showStats && stats && (
        <div style={{
          position: "absolute", zIndex: 3, right: 8, bottom: 12, padding: 12,
          background: "rgba(0,0,0,0.82)", color: "#fff", font: "13px monospace", borderRadius: 8,
          display: "flex", flexDirection: "column", gap: 4, minWidth: 180,
        }}>
          <div><b>📊 통계</b></div>
          <div>가우시안: {stats.live.toLocaleString()}{stats.live !== stats.slots && ` / ${stats.slots.toLocaleString()} 슬롯`}</div>
          <div>바운드: {stats.size.map((v) => v.toFixed(2)).join(" × ")}</div>
          <div>선택: {selection.size.toLocaleString()}</div>
          <div>메모리: {stats.mb.toFixed(1)} MB</div>
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

      <Canvas dpr={dpr} gl={{ preserveDrawingBuffer: true }} camera={{ position: [5, -5, 5], up: [0, 0, 1], near: 0.01, far: 1000 }}>
        <color attach="background" args={[bg]} />
        <OrbitControls makeDefault />
        <CanvasCapture captureRef={captureRef} download={downloadBlob} />
        <InputController bufferRef={bufferRef} selectionRef={selectionRef} setSelection={setSelection} setDrag={setDrag} setSelecting={setSelecting} />
        {showAxes && bounds && <axesHelper args={[radius(bounds)]} />}
        {buffer && bounds && selection.size > 0 && (
          <DragMoveHandle buffer={buffer} selection={selection} onCommit={moveSelection} size={radius(bounds) * 0.04} />
        )}
        <RenderSettingsContext.Provider value={settings}>
          {showGrid && bounds && <DashedGrid bounds={bounds} opts={grid} />}
          {display && bounds && (
            <>
              <FitCamera bounds={bounds} />
              <SplatRenderContext key={splatKey}>
                <SplatObject buffer={display} />
              </SplatRenderContext>
            </>
          )}
        </RenderSettingsContext.Provider>
      </Canvas>
    </div>
  );
}
