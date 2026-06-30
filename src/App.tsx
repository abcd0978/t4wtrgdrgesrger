import React from "react";
import { Canvas } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import { DataUtils } from "three";
import { SplatRenderContext, SplatObject } from "./splat/GaussianSplats";
import { getDeltaManifest, getAddedNpz, getSnapshot, getRuns, type RunInfo } from "./lib/gaussianApi";
import { unzipNpz, npzToPacked } from "./lib/pack";
import { type Bounds, computeBounds, radius, selCenter } from "./lib/bounds";
import { rotateCovariance, scaleCovariance, rotationAboutAxis } from "./lib/mathUtils";
import { DEFAULT_SETTINGS, RenderSettings, RenderSettingsContext } from "./RenderSettings";
import { FitCamera, ApplyCamera, CameraBridge, MeasureView, DashedGrid, InputController, DragMoveHandle, CanvasCapture, type GridOpts, type DragRect } from "./components/SceneObjects";
import { SettingsPanel } from "./components/SettingsPanel";
import { packedToPly, parsePly } from "./lib/ply";
import { readUrlState, buildShareUrl } from "./lib/urlState";

type Vis = { mode: "all" | "hide" | "isolate"; set: Set<number> };
type View = { p: [number, number, number]; t: [number, number, number] };
const dist3 = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const FPS_MIN = 0.5, FPS_MAX = 60;

const HELP = [
  ["드래그", "카메라 회전"],
  ["스크롤", "확대 / 축소"],
  ["더블클릭", "가우시안 1개 선택"],
  ["더블클릭 + 드래그", "박스로 여러 개 선택 (Shift: 추가)"],
  ["주황 핸들 드래그", "선택한 것 이동"],
  ["왼쪽 패널", "이동·회전·스케일·색·복제·숨기기·격리·삭제"],
  ["측정 버튼", "두 점 더블클릭 → 실측 거리"],
  ["타임라인 (delta)", "▶ 재생 · 속도 · 구간 지정 → 구간 .ply"],
  ["PLY 열기 / 내보내기 / 공유", "로컬 .ply 로드 · .ply 저장 · 링크"],
  ["스크린샷", "현재 화면 PNG 저장"],
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
  const [vis, setVis] = React.useState<Vis>({ mode: "all", set: new Set() });
  const [frameCum, setFrameCum] = React.useState<number[] | null>(null); // delta cumulative counts
  const [frameIdx, setFrameIdx] = React.useState(0);
  const [playing, setPlaying] = React.useState(false);
  const [fps, setFps] = React.useState(10);
  const [clipIn, setClipIn] = React.useState(0);
  const [clipOut, setClipOut] = React.useState(0);
  const [measureMode, setMeasureMode] = React.useState(false);
  const [measurePts, setMeasurePts] = React.useState<[number, number, number][]>([]);
  const [camDone, setCamDone] = React.useState(false); // first fit / URL view applied
  const captureRef = React.useRef<((name: string) => void) | null>(null);
  const fileRef = React.useRef<HTMLInputElement>(null);
  const viewRef = React.useRef<(() => View) | null>(null);
  const pendingView = React.useRef<View | null>(null);
  const pendingSel = React.useRef<number[] | null>(null);
  const didInit = React.useRef(false);
  const originalBuffer = React.useRef<Uint32Array | null>(null);
  const bufferRef = React.useRef<Uint32Array | null>(null);
  const selectionRef = React.useRef<Set<number>>(selection);
  selectionRef.current = selection;

  React.useEffect(() => { getRuns(host).then(setRuns).catch(() => setRuns([])); }, [host]);

  async function load(over?: Partial<{ host: string; runId: string; mode: "snapshot" | "delta"; maxFrames: string }>) {
    const _host = over?.host ?? host, _run = over?.runId ?? runId;
    const _mode = over?.mode ?? mode, _maxFrames = over?.maxFrames ?? maxFrames;
    setBusy(true); setBuffer(null); setBounds(null); setSelection(new Set());
    setUndoStack([]); setLiveBuffer(null); originalBuffer.current = null;
    setVis({ mode: "all", set: new Set() }); setFrameCum(null); setPlaying(false);
    try {
      let final: Uint32Array | null = null;
      if (_mode === "snapshot") {
        setStatus("fetching snapshot…");
        final = npzToPacked(await unzipNpz(await getSnapshot(_host, _run)));
        setBuffer(final); setBounds(computeBounds(final));
        setStatus(`done: ${final.length / 8} gaussians`);
      } else {
        setStatus("fetching manifest…");
        const manifest = await getDeltaManifest(_host, _run);
        const limit = Math.min(manifest.frames.length, parseInt(_maxFrames) || manifest.frames.length);
        const total = manifest.frames[limit - 1]?.cumulative_gaussian_count ?? 0;
        const capacity = new Uint32Array(total * 8);
        let offset = 0;
        const updateEvery = Math.max(1, Math.floor(limit / 20));
        for (let i = 0; i < limit; i++) {
          const f = manifest.frames[i];
          const p = npzToPacked(await unzipNpz(await getAddedNpz(_host, _run, f.frame_index)));
          if (offset + p.length <= capacity.length) { capacity.set(p, offset); offset += p.length; }
          if ((i + 1) % updateEvery === 0 || i === limit - 1) {
            setBuffer(capacity.subarray());
            setBounds(computeBounds(capacity.subarray(0, offset)));
            setStatus(`streaming ${i + 1}/${limit} — ${offset / 8} gaussians`);
            await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null))));
          }
        }
        const cum = manifest.frames.slice(0, limit).map((f) => f.cumulative_gaussian_count);
        setFrameCum(cum); setFrameIdx(cum.length - 1);
        setClipIn(0); setClipOut(cum.length - 1);
        final = capacity;
      }
      if (final) originalBuffer.current = final.slice();
      if (pendingSel.current) { setSelection(new Set(pendingSel.current)); pendingSel.current = null; }
    } catch (e) {
      setStatus("error: " + (e as Error).message);
    } finally { setBusy(false); }
  }

  // Restore state from a shared URL on first mount (camera/selection applied post-load).
  React.useEffect(() => {
    if (didInit.current) return;
    didInit.current = true;
    const u = readUrlState();
    if (u.host !== undefined) setHost(u.host);
    if (u.run) setRunId(u.run);
    if (u.mode) setMode(u.mode);
    if (u.maxFrames) setMaxFrames(u.maxFrames);
    if (u.cam) pendingView.current = u.cam;
    if (u.sel) pendingSel.current = u.sel;
    if (u.run) load({ host: u.host, runId: u.run, mode: u.mode, maxFrames: u.maxFrames });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // The rendered buffer: timeline truncation + hide/isolate (alpha 0) + selection
  // highlight, all overlaid on a copy so edits stay on the real `buffer`. Same
  // length as `buffer` -> renderer updates in place (scrubbing stays snappy).
  const displayBuffer = React.useMemo(() => {
    if (!buffer) return null;
    // At the last frame, show the whole (possibly edited) buffer; only truncate
    // when scrubbed back. Keeps edits/duplicates visible in delta mode.
    const scrubbing = frameCum != null && frameIdx < frameCum.length - 1;
    const frontier = scrubbing ? frameCum![frameIdx] : Infinity;
    if (selection.size === 0 && vis.mode === "all" && !scrubbing) return buffer;
    const hb = buffer.slice();
    const dv = new DataView(hb.buffer);
    const slots = hb.length / 8;
    if (scrubbing || vis.mode !== "all") {
      for (let i = 0; i < slots; i++) {
        let hide = i >= frontier;
        if (vis.mode === "hide") hide = hide || vis.set.has(i);
        else if (vis.mode === "isolate") hide = hide || !vis.set.has(i);
        if (hide) dv.setUint8(i * 32 + 31, 0);
      }
    }
    for (const i of selection) {
      if (i < frontier && dv.getUint8(i * 32 + 31) !== 0) {
        dv.setUint8(i * 32 + 28, 255); dv.setUint8(i * 32 + 29, 90); dv.setUint8(i * 32 + 30, 0);
      }
    }
    return hb;
  }, [buffer, selection, vis, frameCum, frameIdx]);

  bufferRef.current = displayBuffer; // pick against what's actually visible

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

  // Rotate / scale the selection about its centroid: positions move, and the
  // covariance transforms with it (Σ' = R Σ Rᵀ / diag(s) Σ diag(s)).
  function rotateSelection(axis: 0 | 1 | 2, deg: number) {
    if (!buffer || selection.size === 0) return;
    const c = selCenter(buffer, selection);
    const R = rotationAboutAxis(axis, (deg * Math.PI) / 180);
    const cov = [0, 0, 0, 0, 0, 0];
    commitEdit((dv, b) => {
      const px = dv.getFloat32(b, true) - c[0], py = dv.getFloat32(b + 4, true) - c[1], pz = dv.getFloat32(b + 8, true) - c[2];
      dv.setFloat32(b, c[0] + R[0] * px + R[1] * py + R[2] * pz, true);
      dv.setFloat32(b + 4, c[1] + R[3] * px + R[4] * py + R[5] * pz, true);
      dv.setFloat32(b + 8, c[2] + R[6] * px + R[7] * py + R[8] * pz, true);
      for (let k = 0; k < 6; k++) cov[k] = DataUtils.fromHalfFloat(dv.getUint16(b + 16 + k * 2, true));
      const rc = rotateCovariance(cov, R);
      for (let k = 0; k < 6; k++) dv.setUint16(b + 16 + k * 2, DataUtils.toHalfFloat(rc[k]), true);
    }, `rotated ${selection.size} gaussians`);
  }

  function scaleSelection(f: number) {
    if (!buffer || selection.size === 0) return;
    const c = selCenter(buffer, selection);
    const cov = [0, 0, 0, 0, 0, 0];
    commitEdit((dv, b) => {
      dv.setFloat32(b, c[0] + (dv.getFloat32(b, true) - c[0]) * f, true);
      dv.setFloat32(b + 4, c[1] + (dv.getFloat32(b + 4, true) - c[1]) * f, true);
      dv.setFloat32(b + 8, c[2] + (dv.getFloat32(b + 8, true) - c[2]) * f, true);
      for (let k = 0; k < 6; k++) cov[k] = DataUtils.fromHalfFloat(dv.getUint16(b + 16 + k * 2, true));
      const sc = scaleCovariance(cov, f, f, f);
      for (let k = 0; k < 6; k++) dv.setUint16(b + 16 + k * 2, DataUtils.toHalfFloat(sc[k]), true);
    }, `scaled ${selection.size} gaussians`);
  }

  // Copy the selection (offset along X) into appended slots; select the copies.
  function duplicateSelection() {
    if (!buffer || selection.size === 0 || !bounds) return;
    const sel = [...selection];
    const nb = new Uint32Array(buffer.length + sel.length * 8);
    nb.set(buffer);
    const dv = new DataView(nb.buffer);
    const off = radius(bounds) * 0.05;
    const newSel = new Set<number>();
    let w = buffer.length;
    for (const i of sel) {
      nb.copyWithin(w, i * 8, i * 8 + 8);
      dv.setFloat32(w * 4, dv.getFloat32(w * 4, true) + off, true);
      newSel.add(w / 8);
      w += 8;
    }
    setUndoStack((s) => [...s.slice(-29), buffer]);
    setBuffer(nb); setBounds(computeBounds(nb)); setSelection(newSel);
    setStatus(`duplicated ${sel.length} gaussians`);
  }

  // Hide/isolate are non-destructive (display-only alpha 0); not on the undo stack.
  function hideSelection() {
    if (selection.size === 0) return;
    setVis((v) => ({ mode: "hide", set: v.mode === "hide" ? new Set([...v.set, ...selection]) : new Set(selection) }));
  }
  function isolateSelection() {
    if (selection.size === 0) return;
    setVis({ mode: "isolate", set: new Set(selection) });
  }
  function showAll() { setVis({ mode: "all", set: new Set() }); }

  function onMeasurePick(p: [number, number, number]) {
    setMeasurePts((prev) => (prev.length >= 2 ? [p] : [...prev, p]));
  }
  const measureDist = measurePts.length === 2 ? dist3(measurePts[0], measurePts[1]) : null;

  function share() {
    const v = viewRef.current?.();
    const url = buildShareUrl({
      host, run: runId, mode, maxFrames,
      cam: v ?? undefined,
      sel: selection.size > 0 ? [...selection] : undefined,
    });
    const c = navigator.clipboard;
    if (c) c.writeText(url).then(() => setStatus("공유 링크 복사됨")).catch(() => setStatus(url));
    else setStatus(url);
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

  // Load a local .ply file into the viewer (no server needed).
  async function onPlyFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-picking the same file
    if (!file) return;
    setBusy(true); setStatus(`reading ${file.name}…`);
    try {
      const b = parsePly(await file.arrayBuffer());
      setSelection(new Set()); setUndoStack([]); setLiveBuffer(null);
      setVis({ mode: "all", set: new Set() }); setFrameCum(null); setPlaying(false);
      setBuffer(b); setBounds(computeBounds(b));
      originalBuffer.current = b.slice();
      setStatus(`loaded ${file.name}: ${b.length / 8} gaussians`);
    } catch (err) {
      setStatus("ply error: " + (err as Error).message);
    } finally { setBusy(false); }
  }

  // Timeline auto-play: advance the scrub frame, looping within the [in,out] clip.
  React.useEffect(() => {
    if (!playing || !frameCum) return;
    const a = Math.min(clipIn, clipOut), b = Math.max(clipIn, clipOut);
    const id = setInterval(() => setFrameIdx((i) => (i >= b ? a : i + 1)), 1000 / Math.max(0.1, fps));
    return () => clearInterval(id);
  }, [playing, fps, clipIn, clipOut, frameCum]);

  // Export only the gaussians added within the clip range [in,out] as a .ply.
  function exportRangePly() {
    if (!buffer || !frameCum) return;
    const a = Math.min(clipIn, clipOut), b = Math.max(clipIn, clipOut);
    const lo = a > 0 ? frameCum[a - 1] : 0;
    const hi = frameCum[b];
    if (hi <= lo) return;
    downloadBlob(packedToPly(buffer.subarray(lo * 8, hi * 8)), `${runId || "gaussians"}_f${a}-${b}.ply`);
    setStatus(`exported frames ${a}–${b} → ${hi - lo} gaussians (.ply)`);
  }

  // Drag the fps control left/right to change playback speed freely: the further
  // you drag, the bigger the change (0.2 fps per pixel, 0.5-step, clamped).
  function startFpsDrag(e: React.PointerEvent) {
    e.preventDefault();
    const startX = e.clientX, startFps = fps;
    const onMove = (ev: PointerEvent) => {
      const next = startFps + (ev.clientX - startX) * 0.2;
      setFps(Math.min(FPS_MAX, Math.max(FPS_MIN, Math.round(next * 2) / 2)));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
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

  const display = liveBuffer ?? displayBuffer;
  const hasTimeline = !!(frameCum && frameCum.length > 1);
  const clipA = Math.min(clipIn, clipOut), clipB = Math.max(clipIn, clipOut);
  const tlPct = (i: number) => (hasTimeline ? (i / (frameCum!.length - 1)) * 100 : 0);
  const rangeCount = frameCum ? frameCum[clipB] - (clipA > 0 ? frameCum[clipA - 1] : 0) : 0;

  return (
    <div style={{ position: "fixed", inset: 0 }}>
      <div className="panel toolbar">
        <input value={host} onChange={(e) => setHost(e.target.value)} placeholder="(empty = this server)" className="grow" style={{ minWidth: 120 }} />
        <select value={runId} onChange={(e) => setRunId(e.target.value)} style={{ flex: 2, minWidth: 160 }}>
          {runs.length === 0 && <option value={runId}>{runId}</option>}
          {runs.map((r) => <option key={r.runId} value={r.runId}>{r.runId} ({r.gaussians})</option>)}
        </select>
        <select value={mode} onChange={(e) => setMode(e.target.value as "snapshot" | "delta")}>
          <option value="snapshot">snapshot</option>
          <option value="delta">delta</option>
        </select>
        {mode === "delta" && <input value={maxFrames} onChange={(e) => setMaxFrames(e.target.value)} title="max delta frames" style={{ width: 56 }} />}
        <button className="accent" onClick={() => load()} disabled={busy}>{busy ? "…" : "Load"}</button>
        <input ref={fileRef} type="file" accept=".ply" style={{ display: "none" }} onChange={onPlyFile} />
        <button onClick={() => fileRef.current?.click()} disabled={busy} title="로컬 .ply 파일 열기">PLY 열기</button>
        <button onClick={undo} disabled={undoStack.length === 0}>undo</button>
        <button onClick={reset} disabled={!originalBuffer.current}>reset</button>
        {selection.size > 0 && <button onClick={() => setSelection(new Set())}>clear ({selection.size})</button>}
        {vis.mode !== "all" && <button onClick={showAll}>전체 보기</button>}
        <button className={measureMode ? "active" : ""} onClick={() => { setMeasureMode((m) => !m); setMeasurePts([]); }} disabled={!buffer}>측정</button>
        <button onClick={exportPly} disabled={!buffer}>내보내기</button>
        <button onClick={() => captureRef.current?.(`${runId || "viser"}.png`)} disabled={!buffer}>스크린샷</button>
        <button onClick={share} disabled={!buffer}>공유</button>
        <button onClick={() => setShowStats((v) => !v)}>통계</button>
        <button className="ghost icon" onClick={() => setShowHelp((v) => !v)}>?</button>
        <button className="ghost icon" onClick={() => setShowPanel((v) => !v)}>⚙</button>
        <span className="grow muted num" style={{ minWidth: 90, textAlign: "right" }}>{status}</span>
      </div>

      {showPanel && (
        <SettingsPanel
          settings={settings}
          setSettings={setSettings}
          scene={{ bg, setBg, showGrid, setShowGrid, grid, setGrid, dpr, setDpr, showAxes, setShowAxes }}
        />
      )}

      {showHelp && (
        <div className="panel" style={{ left: 10, bottom: hasTimeline ? 112 : 10, maxWidth: 420 }}>
          <div className="panel-section">
            <div className="row" style={{ justifyContent: "space-between" }}>
              <span className="panel-title">📖 사용 방법</span>
              <button className="ghost icon" onClick={() => setShowHelp(false)}>✕</button>
            </div>
            {HELP.map(([k, v]) => (
              <div key={k} className="row" style={{ alignItems: "baseline" }}>
                <span className="kbd">{k}</span><span className="muted">{v}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {selection.size > 0 && !measureMode && (
        <div className="panel scroll" style={{ top: 62, left: 10, width: 214, maxHeight: "calc(100vh - 84px)" }}>
          <div className="panel-section">
            <div className="panel-title">선택 {selection.size.toLocaleString()}개</div>

            <label className="row muted">이동
              <input type="range" className="grow" min={0.01} max={1} step={0.01} value={moveStep} onChange={(e) => setMoveStep(parseFloat(e.target.value))} />
              <span className="num" style={{ width: 36, textAlign: "right" }}>{moveStep}</span>
            </label>
            {([["X", 0], ["Y", 1], ["Z", 2]] as const).map(([ax, i]) => (
              <div key={ax} className="seg">
                <span className="axis">{ax}</span>
                <button onClick={() => moveSelection(i === 0 ? -moveStep : 0, i === 1 ? -moveStep : 0, i === 2 ? -moveStep : 0)}>−</button>
                <button onClick={() => moveSelection(i === 0 ? moveStep : 0, i === 1 ? moveStep : 0, i === 2 ? moveStep : 0)}>＋</button>
              </div>
            ))}

            <hr className="divider" />
            <div className="muted">회전 / 스케일</div>
            {(["X", "Y", "Z"] as const).map((ax, i) => (
              <div key={ax} className="seg">
                <span className="axis">{ax}</span>
                <button onClick={() => rotateSelection(i as 0 | 1 | 2, -15)}>⟲ 15°</button>
                <button onClick={() => rotateSelection(i as 0 | 1 | 2, 15)}>⟳ 15°</button>
              </div>
            ))}
            <div className="seg">
              <span className="axis">⤢</span>
              <button onClick={() => scaleSelection(1 / 1.1)}>− 작게</button>
              <button onClick={() => scaleSelection(1.1)}>＋ 크게</button>
            </div>

            <hr className="divider" />
            <label className="row muted">색
              <input type="color" value={editColor} onChange={(e) => setEditColor(e.target.value)} />
              <span className="grow" />
              <span className="num">α</span>
              <input type="range" min={0} max={1} step={0.01} value={editAlpha} onChange={(e) => setEditAlpha(parseFloat(e.target.value))} style={{ width: 72 }} />
            </label>
            <button onClick={applyColorOpacity}>색·불투명도 적용</button>

            <hr className="divider" />
            <div className="row">
              <button className="grow" onClick={duplicateSelection}>복제</button>
              <button className="grow" onClick={hideSelection}>숨기기</button>
            </div>
            <div className="row">
              <button className="grow" onClick={isolateSelection}>격리</button>
              <button className="grow danger" onClick={deleteSelection}>삭제</button>
            </div>
          </div>
        </div>
      )}

      {measureMode && (
        <div className="panel" style={{ top: 64, left: "50%", transform: "translateX(-50%)", maxWidth: 360 }}>
          <div className="panel-section" style={{ gap: 6 }}>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <span className="panel-title">📏 측정</span>
              <button className="ghost icon" onClick={() => { setMeasureMode(false); setMeasurePts([]); }}>✕</button>
            </div>
            <span className="muted">가우시안 두 점을 더블클릭 ({measurePts.length}/2)</span>
            {measureDist != null && <span className="num" style={{ fontSize: 17, color: "var(--accent-2)" }}>거리: {measureDist.toFixed(3)}</span>}
          </div>
        </div>
      )}

      {hasTimeline && (
        <div className="panel" style={{ bottom: 10, left: 10, right: 10 }}>
          <div className="panel-section" style={{ gap: 12 }}>
            <div className="timeline-track">
              <div className="tl-bar" />
              <div className="tl-band" style={{ left: `${tlPct(clipA)}%`, width: `${tlPct(clipB) - tlPct(clipA)}%` }} />
              <div className="tl-mark" style={{ left: `${tlPct(clipA)}%` }}><span className="lbl">구간 시작</span></div>
              <div className="tl-mark" style={{ left: `${tlPct(clipB)}%` }}><span className="lbl">구간 끝</span></div>
              <input type="range" className="timeline" min={0} max={frameCum!.length - 1} step={1} value={frameIdx} onChange={(e) => { setPlaying(false); setFrameIdx(parseInt(e.target.value)); }} />
            </div>
            <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
              <button className={playing ? "active icon" : "icon"} onClick={() => setPlaying((p) => !p)} title="재생 / 일시정지">{playing ? "⏸" : "▶"}</button>
              <button className="ghost num" style={{ minWidth: 92, cursor: "ew-resize", touchAction: "none", userSelect: "none" }} onPointerDown={startFpsDrag} title="좌우로 드래그해서 재생 속도 조절">⇄ {Number.isInteger(fps) ? fps : fps.toFixed(1)} fps</button>
              <span className="num muted" style={{ whiteSpace: "nowrap" }}>{frameIdx + 1}/{frameCum!.length}</span>
              <span className="grow" />
              <button onClick={() => setClipIn(frameIdx)} title="현재 프레임을 구간 시작으로">구간 시작</button>
              <button onClick={() => setClipOut(frameIdx)} title="현재 프레임을 구간 끝으로">구간 끝</button>
              <button className="ghost" onClick={() => { setClipIn(0); setClipOut(frameCum!.length - 1); }} title="구간을 전체로 되돌리기">구간 해제</button>
              <span className="num muted" style={{ whiteSpace: "nowrap" }}>[{clipA}–{clipB}] · {rangeCount.toLocaleString()}</span>
              <button onClick={exportRangePly} title="선택 구간의 가우시안을 .ply로 추출">구간 .ply</button>
            </div>
          </div>
        </div>
      )}

      {showStats && stats && (
        <div className="panel" style={{ right: 10, bottom: hasTimeline ? 112 : 10, minWidth: 200 }}>
          <div className="panel-section" style={{ gap: 6 }}>
            <div className="panel-title">📊 통계</div>
            <div className="row" style={{ justifyContent: "space-between" }}><span className="muted">가우시안</span><span className="num">{stats.live.toLocaleString()}{stats.live !== stats.slots && ` / ${stats.slots.toLocaleString()}`}</span></div>
            <div className="row" style={{ justifyContent: "space-between" }}><span className="muted">바운드</span><span className="num">{stats.size.map((v) => v.toFixed(2)).join(" × ")}</span></div>
            <div className="row" style={{ justifyContent: "space-between" }}><span className="muted">선택</span><span className="num">{selection.size.toLocaleString()}</span></div>
            <div className="row" style={{ justifyContent: "space-between" }}><span className="muted">메모리</span><span className="num">{stats.mb.toFixed(1)} MB</span></div>
          </div>
        </div>
      )}

      {drag && (
        <div style={{
          position: "absolute", zIndex: 2, pointerEvents: "none",
          left: Math.min(drag.x0, drag.x1), top: Math.min(drag.y0, drag.y1),
          width: Math.abs(drag.x1 - drag.x0), height: Math.abs(drag.y1 - drag.y0),
          border: "1.5px solid var(--accent)", background: "rgba(255,139,61,0.15)", borderRadius: 4,
        }} />
      )}

      <Canvas dpr={dpr} gl={{ preserveDrawingBuffer: true }} camera={{ position: [5, -5, 5], up: [0, 0, 1], near: 0.01, far: 1000 }}>
        <color attach="background" args={[bg]} />
        <OrbitControls makeDefault />
        <CanvasCapture captureRef={captureRef} download={downloadBlob} />
        <CameraBridge viewRef={viewRef} />
        <InputController bufferRef={bufferRef} selectionRef={selectionRef} setSelection={setSelection} setDrag={setDrag} setSelecting={setSelecting} measureMode={measureMode} onMeasurePick={onMeasurePick} />
        {showAxes && bounds && <axesHelper args={[radius(bounds)]} />}
        {buffer && bounds && selection.size > 0 && !measureMode && (
          <DragMoveHandle buffer={buffer} selection={selection} onCommit={moveSelection} size={radius(bounds) * 0.04} />
        )}
        {bounds && measurePts.length > 0 && <MeasureView points={measurePts} size={radius(bounds) * 0.03} />}
        <RenderSettingsContext.Provider value={settings}>
          {showGrid && bounds && <DashedGrid bounds={bounds} opts={grid} />}
          {display && bounds && (
            <>
              <FitCamera bounds={bounds} enabled={!camDone && !pendingView.current} onFitted={() => setCamDone(true)} />
              {pendingView.current && <ApplyCamera view={pendingView.current} onApplied={() => setCamDone(true)} />}
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
