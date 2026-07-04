import React from "react";
import { Vector3 } from "three";
import { ConvexHull } from "three/examples/jsm/math/ConvexHull.js";
import { Canvas } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import { SplatRenderContext, SplatObject } from "./splat/GaussianSplats";
import { getDeltaManifest, getAddedNpz, getSnapshot, getRuns, type RunInfo } from "./lib/gaussianApi";
import { unzipNpz, npzToPacked } from "./lib/pack";
import { type Bounds, computeBounds, center, radius, selCenter } from "./lib/bounds";
import { rotateCovariance, scaleCovariance, rotationAboutAxis, covarianceToScaleRotation } from "./lib/mathUtils";
import { makeNpz, npyBytes } from "./lib/npzWrite";
import {
  buildDisplayBuffer, subsampleForLod, subsampleShForLod, rotateSceneBuffer, cropOutside,
  keepOnly, duplicateSelection as dupSelectionOp, deleteIndices,
  invertSelection as invertSelOp, growSelection as growSelOp, colorFilterSelection,
  opacityFilterSelection, selectByPosition, frameArray, computeSceneStats,
} from "./lib/gaussianOps";
import { computeFloaters, computeHeatmap } from "./lib/compute";
import { TEST_SCENE_CDN, TEST_SCENES, DEFAULT_TEST_VIEW, type Recent } from "./lib/scenes";
import { lsGet, lsSet, lsNum, lsBool, lsJson } from "./lib/storage";
import { parseCamPose, formatCamPose } from "./lib/camPose";
import { Hist, HELP } from "./components/Hist";
import { DEFAULT_SETTINGS, RenderSettings, RenderSettingsContext } from "./RenderSettings";
import { FitCamera, ApplyCamera, CameraBridge, MeasureView, PolyhedronPreview, NotesView, DashedGrid, InputController, DragMoveHandle, RotateHandle, CanvasCapture, KeyboardFly, ConstantControlSpeed, GestureControls, AutoOrbit, CameraPath, ClipSweep, FpsMeter, AdaptiveDpr, ContextLossGuard, poseAt, type CamPose, type CameraApi, type GridOpts } from "./components/SceneObjects";
import { SettingsPanel } from "./components/SettingsPanel";
import { packedToPly, parsePly } from "./lib/ply";
import { splatToPacked, fetchSplatToPacked, subsamplePacked } from "./lib/splatFile";
import { hexToRgb, viewOf, readCov6, writeCov6, avgColorHex } from "./lib/gaussianEdit";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import { SelectionPanel, FilterPanel, GroupPanel } from "./components/EditPanels";
import { Dropdown } from "./components/Dropdown";
import { FloatingPanel } from "./components/FloatingPanel";
import { readUrlState, buildShareUrl } from "./lib/urlState";

type Vis = { mode: "all" | "hide" | "isolate"; set: Set<number> };
type View = { p: [number, number, number]; t: [number, number, number]; thumb?: string };
type Group = { id: number; name: string; indices: number[]; hidden: boolean; color: string };
type CompareItem = { id: number; name: string; buffer: Uint32Array; visible: boolean };
const dist3 = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const FPS_MIN = 0.5, FPS_MAX = 60;

export default function App() {
  const [host, setHost] = React.useState(() => lsGet("host", ""));
  const [runId, setRunId] = React.useState(() => lsGet("runId", "online-3dgs-desk-20260624-spnet-gated-full-r2-deltas"));
  const [runs, setRuns] = React.useState<RunInfo[]>([]);
  const [mode, setMode] = React.useState<"snapshot" | "delta">(() => (lsGet("mode", "snapshot") === "delta" ? "delta" : "snapshot"));
  const [maxFrames, setMaxFrames] = React.useState(() => lsGet("maxFrames", "100"));
  const [buffer, setBuffer] = React.useState<Uint32Array | null>(null);
  // Degree-1 SH side buffer (PLY loads only): index-aligned with `buffer`,
  // 8 u32 per gaussian. Cleared whenever indices can't be tracked.
  const [sh1, setSh1] = React.useState<Uint32Array | null>(null);
  const [bounds, setBounds] = React.useState<Bounds | null>(null);
  const [status, setStatus] = React.useState("idle");
  // The status toast fades out a few seconds after the last message.
  const [statusVisible, setStatusVisible] = React.useState(false);
  React.useEffect(() => {
    if (!status) return;
    setStatusVisible(true);
    const id = setTimeout(() => setStatusVisible(false), 5000);
    return () => clearTimeout(id);
  }, [status]);
  const [busy, setBusy] = React.useState(false);

  // Render settings persist across reloads (so quality presets stay applied
  // and correctly highlighted). Session-only fields — clipping, crop box,
  // wipe, derived values — reset to defaults on restore.
  const [settings, setSettings] = React.useState<RenderSettings>(() => {
    const saved = lsJson<Partial<RenderSettings> | null>("renderSettings", null);
    if (saved && typeof saved === "object") {
      return {
        ...DEFAULT_SETTINGS, ...saved,
        clipAxis: -1, clipPos: 0, clipSign: 1,
        cropOn: 0, cropMin: [0, 0, 0], cropMax: [0, 0, 0],
        wipeOn: 0, wipePos: 0.5, lodDistWorld: 0,
      };
    }
    return DEFAULT_SETTINGS;
  });
  React.useEffect(() => { lsSet("renderSettings", JSON.stringify(settings)); }, [settings]);
  const [showPanel, setShowPanel] = React.useState(false);
  const [showHelp, setShowHelp] = React.useState(() => typeof window === "undefined" || window.innerWidth > 700);
  const [menuOpen, setMenuOpen] = React.useState(false); // mobile toolbar hamburger
  const [showTimeline, setShowTimeline] = React.useState(true);
  const [live, setLive] = React.useState(false); // poll server for new delta frames
  const liveCtxRef = React.useRef<{ host: string; run: string } | null>(null);
  const pollingRef = React.useRef(false);
  const [showGroups, setShowGroups] = React.useState(false);
  const [groups, setGroups] = React.useState<Group[]>([]);
  const groupIdRef = React.useRef(1);
  const [showCompare, setShowCompare] = React.useState(false);
  const [run2, setRun2] = React.useState("");
  const [busy2, setBusy2] = React.useState(false);
  const [compares, setCompares] = React.useState<CompareItem[]>([]);
  const compareIdRef = React.useRef(1);
  const [showFilter, setShowFilter] = React.useState(false);
  const [showCrop, setShowCrop] = React.useState(false);
  const [dragOver, setDragOver] = React.useState(false);
  const dragDepth = React.useRef(0);
  const [filterColor, setFilterColor] = React.useState("#ffffff");
  const [filterTol, setFilterTol] = React.useState(60);
  const [filterAdd, setFilterAdd] = React.useState(false);
  const [filterOpMin, setFilterOpMin] = React.useState(1);
  const [filterOpMax, setFilterOpMax] = React.useState(255);
  const [bookmarks, setBookmarks] = React.useState<View[]>(() => lsJson<View[]>("bookmarks", []));
  // Black bg + no grid by default (antimatter15's look): gaussian surfaces are
  // never fully opaque, so a white bg and grid lines bleed through the model
  // and read as a translucent/x-ray effect. Both stay toggleable in settings.
  const [bg, setBg] = React.useState("#000000");
  const [showMap, setShowMap] = React.useState(true);
  const [showGrid, setShowGrid] = React.useState(false);
  const [grid, setGrid] = React.useState<GridOpts>({ color: "#999999", divisions: 20, dashSize: 0.25, gapSize: 0.18 });
  // Splatting is fill-rate bound (translucent quad overdraw), so resolution is
  // the main quality/perf lever. Quality first: auto mode renders at native
  // devicePixelRatio and AdaptiveDpr steps it down only when measured fps
  // can't keep up (and back up when there's headroom). Uncheck 자동 in
  // settings to pin a value manually.
  const nativeDpr = Math.min((typeof window !== "undefined" && window.devicePixelRatio) || 1, 2);
  const [dprAuto, setDprAuto] = React.useState(() => lsBool("dprAuto", true));
  const [autoDprValue, setAutoDprValue] = React.useState(nativeDpr);
  // Manual DPR value used when auto is off.
  const [dpr, setDpr] = React.useState(() => lsNum("dprManual", 1.5, Number.MIN_VALUE));
  const [antialias, setAntialias] = React.useState(false);
  // WebGL context-loss recovery. On loss we remount the Canvas (glEpoch key)
  // so all GPU resources rebuild from the JS-side buffers; glLost drives a
  // brief "recovering" overlay.
  const [glEpoch, setGlEpoch] = React.useState(0);
  const [glLost, setGlLost] = React.useState(false);
  const onGlLost = React.useCallback(() => {
    const cur = camApiRef.current?.get();
    if (cur) pendingView.current = { p: cur.p, t: cur.t }; // restore view after remount
    setGlLost(true);
    setStatus("렌더러 컨텍스트 손실 — 복구 중…");
  }, []);
  const onGlRestored = React.useCallback(() => {
    setGlLost(false);
    setCamDone(false);
    setGlEpoch((e) => e + 1); // remount Canvas to rebuild GPU state cleanly
    setStatus("렌더러 복구됨");
  }, []);
  // Control sensitivities (persisted). Two knobs only: rotate and zoom, both
  // applying to mouse AND touch — the touch-specific attenuation is a fixed
  // internal factor inside ConstantControlSpeed.
  const [rotateSens, setRotateSens] = React.useState(() => lsNum("rotateSens", 1, Number.MIN_VALUE));
  const [zoomSens, setZoomSens] = React.useState(() => lsNum("zoomSens", 1, Number.MIN_VALUE));
  // Translation sensitivity: right-drag / two-finger pan AND WASD fly.
  const [moveSens, setMoveSens] = React.useState(() => lsNum("moveSens", 1, Number.MIN_VALUE));
  // Adaptive-DPR floor: resolution is shed only when fps falls below this.
  const [minFps, setMinFps] = React.useState(() => lsNum("minFps", 15, 5));
  // Undo/redo snapshot memory budget (MB).
  const [undoCapMB, setUndoCapMB] = React.useState(() => Math.round(lsNum("undoCapMB", 384, 64)));
  // Load-time subsampling for test/local scenes: keep every Nth gaussian
  // (1 = all). Unlike LOD 비율 this cuts real memory, not just draw cost.
  const [loadDiv, setLoadDiv] = React.useState(() => {
    const v = parseInt(lsGet("loadDiv", "1"));
    return v === 2 || v === 4 ? v : 1;
  });
  // Recently opened scenes (server runs + CDN test scenes; local files can't
  // be reopened without a file handle, so they're not recorded).
  const [recents, setRecents] = React.useState<Recent[]>(() => lsJson<Recent[]>("recents", []));
  const recordRecent = React.useCallback((r: Recent) => {
    setRecents((prev) => {
      const keyOf = (x: Recent) => (x.k === "test" ? `t:${x.f}` : `r:${x.host}|${x.run}|${x.mode}`);
      const next = [r, ...prev.filter((x) => keyOf(x) !== keyOf(r))].slice(0, 6);
      lsSet("recents", JSON.stringify(next));
      return next;
    });
  }, []);
  React.useEffect(() => {
    lsSet("rotateSens", String(rotateSens));
    lsSet("zoomSens", String(zoomSens));
    lsSet("moveSens", String(moveSens));
    lsSet("minFps", String(minFps));
    lsSet("undoCapMB", String(undoCapMB));
    lsSet("dprAuto", dprAuto ? "1" : "0");
    lsSet("dprManual", String(dpr));
    lsSet("loadDiv", String(loadDiv));
  }, [rotateSens, zoomSens, moveSens, minFps, undoCapMB, dprAuto, dpr, loadDiv]);
  const [showAxes, setShowAxes] = React.useState(false);

  // selection + editing
  const [selection, setSelection] = React.useState<Set<number>>(new Set());
  const [liveBuffer, setLiveBuffer] = React.useState<Uint32Array | null>(null);
  // Polygon select: screen-space vertices picked by double-click; gaussians
  // inside the (front-surface filtered) polygon get selected.
  const [polyMode, setPolyMode] = React.useState(false);
  const [polyPts, setPolyPts] = React.useState<[number, number, number][]>([]);
  const [polyAdd, setPolyAdd] = React.useState(false);
  const [savedRegions, setSavedRegions] = React.useState<{ id: number; name: string; pts: [number, number, number][] }[]>([]);
  const regionIdRef = React.useRef(1);
  // 3D annotations (pin + label anchored to a gaussian). Shared via URL.
  const [notes, setNotes] = React.useState<{ id: number; p: [number, number, number]; text: string }[]>([]);
  const [noteMode, setNoteMode] = React.useState(false);
  const noteIdRef = React.useRef(1);
  const [undoStack, setUndoStack] = React.useState<Uint32Array[]>([]);
  const [redoStack, setRedoStack] = React.useState<Uint32Array[]>([]);
  const [splatKey, setSplatKey] = React.useState(0); // bump to remount renderer after an edit
  const [moveStep, setMoveStep] = React.useState(0.05);
  const [rotStep, setRotStep] = React.useState(15); // selection rotation step (deg)
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
  const [autoOrbit, setAutoOrbit] = React.useState(false);
  const [autoOrbitSpeed, setAutoOrbitSpeed] = React.useState(0.5);
  const [showCamPanel, setShowCamPanel] = React.useState(false);
  const [camRecording, setCamRecording] = React.useState(false);
  const [camReplaying, setCamReplaying] = React.useState(false);
  const [camPath, setCamPath] = React.useState<CamPose[]>([]);
  const [camSeekMs, setCamSeekMs] = React.useState(0);
  const [touring, setTouring] = React.useState(false); // smoothly cycling through bookmarks
  const camRecRef = React.useRef<CamPose[]>([]);
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const videoRecRef = React.useRef<MediaRecorder | null>(null);
  const [videoRec, setVideoRec] = React.useState(false);
  const turntableTimer = React.useRef<number | null>(null);
  const [clipSweep, setClipSweep] = React.useState(false);
  // LOD: fraction of gaussians to draw.
  const [renderFrac, setRenderFrac] = React.useState(() => lsNum("renderFrac", 1, Number.MIN_VALUE, 1));
  React.useEffect(() => { lsSet("renderFrac", String(renderFrac)); }, [renderFrac]);
  const captureRef = React.useRef<((name: string) => void) | null>(null);
  const captureBlobRef = React.useRef<(() => Promise<Blob | null>) | null>(null);
  const fpsElRef = React.useRef<HTMLSpanElement | null>(null);
  const fileRef = React.useRef<HTMLInputElement>(null);
  const compareFileRef = React.useRef<HTMLInputElement>(null);
  const camApiRef = React.useRef<CameraApi | null>(null);
  const pendingView = React.useRef<View | null>(null);
  const pendingSel = React.useRef<number[] | null>(null);
  const didInit = React.useRef(false);
  // Where the current scene came from — decides what a share link can carry.
  const sourceRef = React.useRef<{ kind: "server" | "test" | "local"; file?: string } | null>(null);
  const originalBuffer = React.useRef<Uint32Array | null>(null);
  const editOrigin = React.useRef<Uint32Array | null>(null); // buffer snapshot at drag start
  const workBuf = React.useRef<Uint32Array | null>(null);     // live-edited copy during a drag
  const editCenter = React.useRef<[number, number, number]>([0, 0, 0]);
  const editMoved = React.useRef(false);
  const bufferRef = React.useRef<Uint32Array | null>(null);
  // Latest raw (unedited-overlay) buffer — lets async worker ops detect that the
  // scene changed mid-scan and abandon a stale write.
  const rawBufferRef = React.useRef<Uint32Array | null>(null);
  rawBufferRef.current = buffer;
  const selectionRef = React.useRef<Set<number>>(selection);
  selectionRef.current = selection;

  // Live camera pose readout for the stats panel (polled only while open).
  const [camPose, setCamPose] = React.useState<{ p: [number, number, number]; t: [number, number, number]; d: [number, number, number] } | null>(null);
  React.useEffect(() => {
    if (!showStats) return;
    const id = setInterval(() => {
      const v = camApiRef.current?.get();
      if (!v) return;
      const dx = v.t[0] - v.p[0], dy = v.t[1] - v.p[1], dz = v.t[2] - v.p[2];
      const L = Math.hypot(dx, dy, dz) || 1;
      setCamPose({ p: v.p, t: v.t, d: [dx / L, dy / L, dz / L] });
    }, 250);
    return () => clearInterval(id);
  }, [showStats]);
  function copyCamPose() {
    if (!camPose) return;
    const text = formatCamPose(camPose.p, camPose.t);
    navigator.clipboard?.writeText(text).then(() => setStatus(`카메라 좌표 복사됨: ${text}`)).catch(() => setStatus(text));
  }
  // Jump to a pasted pose. Accepts the copy button's JSON ({p:[..], t:[..]}),
  // or bare numbers: 6 = position+target, 3 = position only (keep the target).
  const [camPoseInput, setCamPoseInput] = React.useState("");
  function gotoCamPose() {
    if (!camApiRef.current) return;
    const parsed = parseCamPose(camPoseInput);
    if (!parsed) { setStatus('카메라 좌표 형식 오류 — {"p":[x,y,z],"t":[x,y,z]} 또는 숫자 6개(위치+타깃)/3개(위치)'); return; }
    const { p, t } = parsed;
    camApiRef.current.apply(p, t ?? camApiRef.current.get().t);
    setStatus(`카메라 이동: (${p.map((v) => v.toFixed(2)).join(", ")})`);
  }

  const [serverOk, setServerOk] = React.useState<boolean | null>(null);
  const [lastUpdate, setLastUpdate] = React.useState<string>("");
  React.useEffect(() => {
    getRuns(host).then((rs) => { setRuns(rs); setServerOk(true); }).catch(() => { setRuns([]); setServerOk(false); });
  }, [host]);

  // Remember the load inputs so a return visit doesn't need re-typing.
  React.useEffect(() => {
    lsSet("host", host);
    lsSet("runId", runId);
    lsSet("mode", mode);
    lsSet("maxFrames", maxFrames);
  }, [host, runId, mode, maxFrames]);

  React.useEffect(() => { lsSet("bookmarks", JSON.stringify(bookmarks)); }, [bookmarks]);

  async function load(over?: Partial<{ host: string; runId: string; mode: "snapshot" | "delta"; maxFrames: string }>) {
    const _host = over?.host ?? host, _run = over?.runId ?? runId;
    const _mode = over?.mode ?? mode, _maxFrames = over?.maxFrames ?? maxFrames;
    setBusy(true); setBuffer(null); setSh1(null); setBounds(null); setSelection(new Set());
    setUndoStack([]); setRedoStack([]); setLiveBuffer(null); originalBuffer.current = null;
    setVis({ mode: "all", set: new Set() }); setFrameCum(null); setPlaying(false); setGroups([]);
    setLive(false); liveCtxRef.current = null;
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
        liveCtxRef.current = { host: _host, run: _run }; // enable live polling for this run
        final = capacity;
      }
      // Share the reference (no copy): every edit path is copy-on-write, so
      // the freshly loaded array is never mutated — a .slice() here doubled
      // load-time memory on multi-million-splat scenes.
      if (final) originalBuffer.current = final;
      sourceRef.current = { kind: "server" };
      recordRecent({ k: "run", host: _host, run: _run, mode: _mode, maxFrames: _maxFrames, label: _run });
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
    // Shared render settings / display options override the local ones so the
    // recipient sees the exact same picture (session-only fields stay off).
    if (u.rs) {
      setSettings((s) => ({
        ...s, ...(u.rs as Partial<RenderSettings>),
        cropOn: 0, cropMin: [0, 0, 0], cropMax: [0, 0, 0], wipeOn: 0, wipePos: 0.5, lodDistWorld: 0,
      }));
    }
    if (u.sc) {
      const sc = u.sc;
      if (typeof sc.bg === "string") setBg(sc.bg);
      if (sc.showMap !== undefined) setShowMap(!!sc.showMap);
      if (sc.showGrid !== undefined) setShowGrid(!!sc.showGrid);
      if (sc.grid) setGrid({ ...sc.grid });
      if (sc.showAxes !== undefined) setShowAxes(!!sc.showAxes);
      if (sc.dprAuto !== undefined) setDprAuto(!!sc.dprAuto);
      if (typeof sc.dpr === "number" && sc.dpr > 0) setDpr(sc.dpr);
      if (typeof sc.renderFrac === "number" && sc.renderFrac > 0 && sc.renderFrac <= 1) setRenderFrac(sc.renderFrac);
    }
    if (u.notes) {
      let nid = 1;
      setNotes(u.notes.map((n) => ({ id: nid++, p: n.p, text: n.text })));
      noteIdRef.current = nid;
    }
    if (u.path) setCamPath(u.path);
    if (u.run) {
      load({ host: u.host, runId: u.run, mode: u.mode, maxFrames: u.maxFrames });
    } else if (u.test) {
      // Shared CDN test scene. (loadTestScene's sync prefix clears
      // pendingView, so the shared camera is re-set right after the call.)
      const scene = TEST_SCENES.find((sc2) => sc2.file === u.test) ?? { name: u.test.replace(/\.splat$/i, ""), file: u.test };
      loadTestScene(scene);
      if (u.cam) pendingView.current = u.cam;
    } else {
      // No shared/run URL: greet with the Train demo instead of an empty
      // "server unreachable" screen.
      loadTestScene(TEST_SCENES[0]);
      if (u.cam) pendingView.current = u.cam;
      else if (DEFAULT_TEST_VIEW) pendingView.current = { p: DEFAULT_TEST_VIEW.p, t: DEFAULT_TEST_VIEW.t };
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Live polling: fetch the manifest and append any new delta frames to the buffer.
  async function pollLive() {
    const ctx = liveCtxRef.current;
    if (!ctx || pollingRef.current || !buffer || !frameCum) return;
    pollingRef.current = true;
    try {
      const manifest = await getDeltaManifest(ctx.host, ctx.run);
      const have = frameCum.length;
      const newLimit = manifest.frames.length;
      if (newLimit <= have) return;
      const parts: Uint32Array[] = [];
      for (let i = have; i < newLimit; i++) {
        parts.push(npzToPacked(await unzipNpz(await getAddedNpz(ctx.host, ctx.run, manifest.frames[i].frame_index))));
      }
      const addLen = parts.reduce((a, p) => a + p.length, 0);
      const nb = new Uint32Array(buffer.length + addLen);
      nb.set(buffer);
      let off = buffer.length;
      for (const p of parts) { nb.set(p, off); off += p.length; }
      const cum = manifest.frames.slice(0, newLimit).map((f) => f.cumulative_gaussian_count);
      setBuffer(nb); setBounds(computeBounds(nb)); setFrameCum(cum);
      setFrameIdx((fi) => (fi >= have - 1 ? cum.length - 1 : fi)); // follow if at the latest frame
      setClipOut((co) => (co >= have - 1 ? cum.length - 1 : co));
      setStatus(`live +${newLimit - have} frames → ${nb.length / 8} gaussians`);
    } catch (e) {
      setStatus("live poll error: " + (e as Error).message);
    } finally { pollingRef.current = false; }
  }
  const pollRef = React.useRef<() => void>(() => {});
  pollRef.current = pollLive;
  React.useEffect(() => {
    if (!live) return;
    const id = setInterval(() => pollRef.current(), 3000);
    return () => clearInterval(id);
  }, [live]);

  // The rendered buffer: timeline truncation + hide/isolate (alpha 0) + selection
  // highlight, all overlaid on a copy so edits stay on the real `buffer`. Same
  // length as `buffer` -> renderer updates in place (scrubbing stays snappy).
  const groupHiddenSet = React.useMemo(() => {
    const s = new Set<number>();
    for (const g of groups) if (g.hidden) for (const i of g.indices) s.add(i);
    return s;
  }, [groups]);

  // At the last frame, show the whole (possibly edited) buffer; only truncate
  // when scrubbed back. Keeps edits/duplicates visible in delta mode.
  const displayBuffer = React.useMemo(
    () => (buffer ? buildDisplayBuffer(buffer, selection, vis, frameCum, frameIdx, groupHiddenSet) : null),
    [buffer, selection, vis, frameCum, frameIdx, groupHiddenSet],
  );

  bufferRef.current = displayBuffer; // pick against what's actually visible

  // Snapshot for undo; any new edit invalidates the redo stack. Stacks are
  // capped by BYTES, not just count — 30 full snapshots of a 6M-splat scene
  // would be ~5.7GB. Oldest entries drop first; the newest always survives.
  const MAX_STACK = 30;
  const maxStackBytes = undoCapMB * 1048576;
  function trimStack(s: Uint32Array[]): Uint32Array[] {
    let bytes = 0, start = s.length;
    while (
      start > 0 &&
      s.length - start < MAX_STACK &&
      (bytes + s[start - 1].byteLength <= maxStackBytes || start === s.length)
    ) {
      bytes += s[--start].byteLength;
    }
    return start === 0 ? s : s.slice(start);
  }
  function pushUndo(buf: Uint32Array) {
    setUndoStack((s) => trimStack([...s, buf]));
    setRedoStack([]);
  }

  // One edit primitive for move/delete/recolor: snapshot for undo, copy, mutate
  // the selected gaussians, swap the ref. Same length -> renderer updates the
  // texture in place (no remount, no bounds re-scan): keeps edits snappy.
  function commitEdit(mutate: (dv: DataView, base: number) => void, msg: string) {
    if (!buffer || selection.size === 0) return;
    pushUndo(buffer);
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

  // --- live handle drag (move / rotate): show the transform in real time ---
  // beginEdit snapshots the buffer; each liveTransform re-derives the selection
  // from that snapshot by the net transform and pushes a preview via liveBuffer
  // (only the selected gaussians are rewritten, so it's cheap on big buffers);
  // endEdit promotes the preview to the real buffer. One undo entry per drag.
  function beginEdit() {
    if (!buffer || selection.size === 0) return;
    editOrigin.current = buffer;
    workBuf.current = buffer.slice();
    editCenter.current = selCenter(buffer, selection);
    editMoved.current = false;
  }
  function liveTransform(mutate: (odv: DataView, wdv: DataView, base: number, c: [number, number, number]) => void, msg: string) {
    const orig = editOrigin.current, work = workBuf.current;
    if (!orig || !work) return;
    if (!editMoved.current) { editMoved.current = true; pushUndo(orig); }
    const odv = new DataView(orig.buffer, orig.byteOffset, orig.byteLength);
    const wdv = new DataView(work.buffer);
    for (const i of selection) mutate(odv, wdv, i * 32, editCenter.current);
    setLiveBuffer(work.subarray());
    setStatus(msg);
  }
  function endEdit() {
    if (editMoved.current && workBuf.current) { setBuffer(workBuf.current); setStatus(`edited ${selection.size} gaussians`); }
    setLiveBuffer(null);
    editOrigin.current = null; workBuf.current = null; editMoved.current = false;
  }
  function liveMove(dx: number, dy: number, dz: number) {
    liveTransform((odv, wdv, b) => {
      wdv.setFloat32(b, odv.getFloat32(b, true) + dx, true);
      wdv.setFloat32(b + 4, odv.getFloat32(b + 4, true) + dy, true);
      wdv.setFloat32(b + 8, odv.getFloat32(b + 8, true) + dz, true);
    }, `moving ${selection.size}…`);
  }
  function liveRotate(R: number[]) {
    const cov = [0, 0, 0, 0, 0, 0];
    liveTransform((odv, wdv, b, c) => {
      const px = odv.getFloat32(b, true) - c[0], py = odv.getFloat32(b + 4, true) - c[1], pz = odv.getFloat32(b + 8, true) - c[2];
      wdv.setFloat32(b, c[0] + R[0] * px + R[1] * py + R[2] * pz, true);
      wdv.setFloat32(b + 4, c[1] + R[3] * px + R[4] * py + R[5] * pz, true);
      wdv.setFloat32(b + 8, c[2] + R[6] * px + R[7] * py + R[8] * pz, true);
      readCov6(odv, b, cov); writeCov6(wdv, b, rotateCovariance(cov, R));
    }, `rotating ${selection.size}…`);
  }

  // Delete = set alpha 0 (the existing "empty slot" sentinel: skipped by render,
  // picking, bounds, and export). Reversible via undo; baked in on export.
  function deleteSelection() {
    const n = selection.size;
    commitEdit((dv, b) => dv.setUint8(b + 31, 0), `deleted ${n} gaussians`);
    setSelection(new Set());
  }

  // Inverse crop: keep ONLY the selection, delete everything else (undoable).
  function keepOnlySelection() {
    if (!buffer || selection.size === 0) return;
    pushUndo(buffer);
    const { buffer: nb, deleted } = keepOnly(buffer, selection);
    setBuffer(nb);
    setStatus(`선택만 남김: ${deleted.toLocaleString()}개 삭제 (undo 가능)`);
  }

  function applyColorOpacity() {
    const [r, g, bl] = hexToRgb(editColor);
    const a = Math.round(editAlpha * 255);
    commitEdit((dv, b) => {
      dv.setUint8(b + 28, r); dv.setUint8(b + 29, g); dv.setUint8(b + 30, bl); dv.setUint8(b + 31, a);
    }, `recolored ${selection.size} gaussians`);
  }

  // Rotate / scale the selection about its centroid: positions move, and the
  // covariance transforms with it (Σ' = R Σ Rᵀ / diag(s) Σ diag(s)).
  // applyRotation takes a row-major 3x3 and commits once (used by the +/- buttons).
  function applyRotation(R: number[]) {
    if (!buffer || selection.size === 0) return;
    const c = selCenter(buffer, selection);
    const cov = [0, 0, 0, 0, 0, 0];
    commitEdit((dv, b) => {
      const px = dv.getFloat32(b, true) - c[0], py = dv.getFloat32(b + 4, true) - c[1], pz = dv.getFloat32(b + 8, true) - c[2];
      dv.setFloat32(b, c[0] + R[0] * px + R[1] * py + R[2] * pz, true);
      dv.setFloat32(b + 4, c[1] + R[3] * px + R[4] * py + R[5] * pz, true);
      dv.setFloat32(b + 8, c[2] + R[6] * px + R[7] * py + R[8] * pz, true);
      readCov6(dv, b, cov); writeCov6(dv, b, rotateCovariance(cov, R));
    }, `rotated ${selection.size} gaussians`);
  }
  function rotateSelection(axis: 0 | 1 | 2, deg: number) {
    applyRotation(rotationAboutAxis(axis, (deg * Math.PI) / 180));
  }

  // Rotate the WHOLE scene about its bounds centre (for fixing a tilted capture).
  // Selection-independent; transforms every gaussian's position + covariance.
  function rotateScene(axis: 0 | 1 | 2, deg: number) {
    if (!buffer || !bounds) return;
    const R = rotationAboutAxis(axis, (deg * Math.PI) / 180);
    pushUndo(buffer);
    const nb = rotateSceneBuffer(buffer, center(bounds), R);
    setBuffer(nb); setBounds(computeBounds(nb));
    setStatus(`scene rotated ${deg}° (${axis === 0 ? "X" : axis === 1 ? "Y" : "Z"})`);
  }

  // --- crop box: shader-side preview (hide outside), then apply = delete ---
  function openCrop() {
    if (!bounds) return;
    setSettings((s) => ({
      ...s, cropOn: 1,
      cropMin: [bounds.min[0], bounds.min[1], bounds.min[2]],
      cropMax: [bounds.max[0], bounds.max[1], bounds.max[2]],
    }));
    setShowCrop(true);
  }
  function closeCrop() {
    setShowCrop(false);
    setSettings((s) => ({ ...s, cropOn: 0 }));
  }
  function setCropVal(which: "cropMin" | "cropMax", axis: number, v: number) {
    setSettings((s) => {
      const arr = [...s[which]] as [number, number, number];
      arr[axis] = v;
      return { ...s, [which]: arr };
    });
  }
  // Bake the crop: alpha-0 everything outside the box (same delete sentinel as
  // the other edit tools, so it exports/undoes consistently).
  function cropDeleteOutside() {
    if (!buffer) return;
    pushUndo(buffer);
    const { buffer: nb, deleted } = cropOutside(buffer, settings.cropMin, settings.cropMax);
    setBuffer(nb);
    closeCrop();
    setStatus(`크롭: 박스 밖 ${deleted.toLocaleString()}개 삭제 (undo 가능)`);
  }

  // Remove "floaters": gaussians with (almost) no neighbours, via a coarse
  // spatial hash grid (see detectFloaters). The scan runs in a worker for big
  // scenes so the UI doesn't freeze (identical result, sync fallback).
  async function cleanFloaters() {
    if (!buffer || !bounds) return;
    const src = buffer;
    setStatus("🧹 플로터 검사 중…");
    const del = await computeFloaters(src, bounds);
    if (rawBufferRef.current !== src) return; // scene changed mid-scan — abandon
    if (del.length === 0) { setStatus("플로터 없음 (기준: 주변 이웃 ≤ 5)"); return; }
    pushUndo(src);
    setBuffer(deleteIndices(src, del));
    setStatus(`🧹 플로터 ${del.length.toLocaleString()}개 삭제 (undo 가능)`);
  }

  // Scale the selection about its centroid, per axis (position + covariance).
  function scaleSelectionXYZ(sx: number, sy: number, sz: number) {
    if (!buffer || selection.size === 0) return;
    const c = selCenter(buffer, selection);
    const cov = [0, 0, 0, 0, 0, 0];
    commitEdit((dv, b) => {
      dv.setFloat32(b, c[0] + (dv.getFloat32(b, true) - c[0]) * sx, true);
      dv.setFloat32(b + 4, c[1] + (dv.getFloat32(b + 4, true) - c[1]) * sy, true);
      dv.setFloat32(b + 8, c[2] + (dv.getFloat32(b + 8, true) - c[2]) * sz, true);
      readCov6(dv, b, cov); writeCov6(dv, b, scaleCovariance(cov, sx, sy, sz));
    }, `scaled ${selection.size} gaussians`);
  }
  function scaleSelection(f: number) { scaleSelectionXYZ(f, f, f); }

  // Copy the selection (offset along X) into appended slots; select the copies.
  function duplicateSelection() {
    if (!buffer || selection.size === 0 || !bounds) return;
    const { buffer: nb, newSel } = dupSelectionOp(buffer, selection, radius(bounds) * 0.05);
    pushUndo(buffer);
    setBuffer(nb); setBounds(computeBounds(nb)); setSelection(newSel);
    setStatus(`duplicated ${selection.size} gaussians`);
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

  // --- polyhedron select / annotation mode helpers ---
  function togglePolyMode() {
    setPolyMode((m) => {
      if (!m) { setMeasureMode(false); setMeasurePts([]); setNoteMode(false); }
      setPolyPts([]);
      return !m;
    });
  }
  function addNoteAt(p: [number, number, number]) {
    const text = window.prompt("주석 내용:");
    if (!text || !text.trim()) return;
    const id = noteIdRef.current++;
    setNotes((ns) => [...ns, { id, p, text: text.trim().slice(0, 200) }]);
    setStatus(`📌 주석 추가됨 (${notes.length + 1}개)`);
  }
  // Select every gaussian inside the convex hull of `pts` (4+ vertices). The
  // hull is anchored to world positions, so it holds as the camera moves.
  function hullSelect(pts: [number, number, number][], additive: boolean): boolean {
    if (!buffer || pts.length < 4) return false;
    let hull: ConvexHull;
    try {
      hull = new ConvexHull().setFromPoints(pts.map((p) => new Vector3(p[0], p[1], p[2])));
    } catch {
      setStatus("다면체를 만들 수 없음 — 점들이 한 평면/직선 위에 있어요");
      return false;
    }
    const v = new Vector3();
    const out = selectByPosition(buffer, (x, y, z) => hull.containsPoint(v.set(x, y, z)), additive ? selection : new Set());
    setSelection(out);
    setStatus(`◆ 다면체 선택: ${out.size.toLocaleString()}개`);
    return true;
  }
  function runPolySelect() {
    if (hullSelect(polyPts, polyAdd)) setPolyPts([]);
  }
  function saveRegion() {
    if (polyPts.length < 4) return;
    const id = regionIdRef.current++;
    setSavedRegions((rs) => [...rs, { id, name: `영역 ${id}`, pts: polyPts }]);
    setStatus(`영역 ${id} 저장됨 (${polyPts.length}점)`);
  }

  // Invert: select every visible gaussian that isn't currently selected.
  function invertSelection() {
    if (!buffer) return;
    const next = invertSelOp(buffer, selection);
    setSelection(next);
    setStatus(`inverted → ${next.size} selected`);
  }

  // Grow: add every visible gaussian inside the (slightly padded) bounding box of
  // the current selection — a cheap way to fill out the region you picked.
  function growSelection() {
    if (!buffer || selection.size === 0) return;
    const next = growSelOp(buffer, selection);
    setSelection(next);
    setStatus(`grown → ${next.size} selected`);
  }

  // Filter-select by colour similarity (RGB euclidean distance <= tolerance).
  function filterByColor() {
    if (!buffer) return;
    const next = colorFilterSelection(buffer, filterColor, filterTol, filterAdd ? selection : new Set());
    setSelection(next);
    setStatus(`color filter → ${next.size} selected`);
  }

  // Filter-select by opacity range (u8 alpha in [min, max]).
  function filterByOpacity() {
    if (!buffer) return;
    const next = opacityFilterSelection(buffer, filterOpMin, filterOpMax, filterAdd ? selection : new Set());
    setSelection(next);
    setStatus(`opacity filter → ${next.size} selected`);
  }

  // Set the filter colour to the average colour of the current selection.
  function pickColorFromSelection() {
    if (!buffer || selection.size === 0) return;
    setFilterColor(avgColorHex(viewOf(buffer), selection, selection.size));
  }

  // --- groups: save a selection, then reselect / hide / recolor / remove it ---
  function createGroup() {
    if (!buffer || selection.size === 0) return;
    const indices = [...selection];
    const id = groupIdRef.current++;
    setGroups((gs) => [...gs, { id, name: `그룹 ${id}`, indices, hidden: false, color: avgColorHex(viewOf(buffer), indices, indices.length) }]);
    setStatus(`group ${id}: ${indices.length} gaussians`);
  }
  function selectGroup(g: Group) { setSelection(new Set(g.indices)); }
  function toggleGroupHide(id: number) { setGroups((gs) => gs.map((g) => (g.id === id ? { ...g, hidden: !g.hidden } : g))); }
  function removeGroup(id: number) { setGroups((gs) => gs.filter((g) => g.id !== id)); }
  function recolorGroup(id: number, color: string) {
    setGroups((gs) => gs.map((g) => (g.id === id ? { ...g, color } : g)));
    const g = groups.find((x) => x.id === id);
    if (!g || !buffer) return;
    const [r, gg, bb] = hexToRgb(color);
    pushUndo(buffer);
    const nb = buffer.slice();
    const dv = new DataView(nb.buffer);
    for (const i of g.indices) { const b = i * 32; dv.setUint8(b + 28, r); dv.setUint8(b + 29, gg); dv.setUint8(b + 30, bb); }
    setBuffer(nb);
    setStatus(`recolored ${g.name}`);
  }

  // Polyline measure: every pick appends a vertex; the panel shows the running
  // total plus the last segment.
  function onMeasurePick(p: [number, number, number]) {
    setMeasurePts((prev) => [...prev, p]);
  }
  const measureTotal = measurePts.length >= 2
    ? measurePts.slice(1).reduce((acc, p, i) => acc + dist3(measurePts[i], p), 0)
    : null;
  const measureLast = measurePts.length >= 2
    ? dist3(measurePts[measurePts.length - 2], measurePts[measurePts.length - 1])
    : null;

  // Share EVERYTHING needed to reproduce this exact screen: scene source
  // (server run or CDN test scene), camera, selection, all render settings,
  // and display options. Local-file scenes can't travel in a URL — the link
  // still carries camera/settings, with a status note.
  function share() {
    const v = camApiRef.current?.get();
    const src = sourceRef.current;
    const {
      cropOn: _a, cropMin: _b, cropMax: _c2, wipeOn: _d, wipePos: _e, lodDistWorld: _f,
      ...rsShare
    } = settings;
    const url = buildShareUrl({
      host: src?.kind === "server" ? host : undefined,
      run: src?.kind === "server" ? runId : undefined,
      mode: src?.kind === "server" ? mode : undefined,
      maxFrames: src?.kind === "server" ? maxFrames : undefined,
      test: src?.kind === "test" ? src.file : undefined,
      cam: v ?? undefined,
      rs: rsShare as unknown as Record<string, unknown>,
      sc: { bg, showMap, showGrid, grid, showAxes, dprAuto, dpr, renderFrac },
      notes: notes.length > 0
        ? notes.slice(0, 20).map((n) => ({ p: n.p.map((x) => +x.toFixed(3)) as [number, number, number], text: n.text }))
        : undefined,
      path: camPath.length >= 2
        ? (() => {
            // Resample the recorded path to <=40 keyframes so it fits a URL
            // (the Catmull-Rom replay smooths between them anyway).
            const step = Math.max(1, Math.ceil(camPath.length / 40));
            const ks = camPath.filter((_, i) => i % step === 0);
            if (ks[ks.length - 1] !== camPath[camPath.length - 1]) ks.push(camPath[camPath.length - 1]);
            return ks.map((k) => ({
              p: k.p.map((x) => +x.toFixed(3)) as [number, number, number],
              t: k.t.map((x) => +x.toFixed(3)) as [number, number, number],
              ms: +k.ms.toFixed(2),
            }));
          })()
        : undefined,
    });
    const note = src?.kind === "local" ? " (로컬 파일 씬은 링크에 담을 수 없어 카메라·설정만 공유됨)" : "";
    const c = navigator.clipboard;
    if (c) c.writeText(url).then(() => setStatus("공유 링크 복사됨" + note)).catch(() => setStatus(url));
    else setStatus(url);
  }

  const downloadBlob = React.useCallback((blob: Blob, name: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = name; a.click();
    URL.revokeObjectURL(url);
  }, []);

  // Per-gaussian frame index (from frameCum), so exports stay replayable.
  const frameArrayFull = (): Uint32Array | null => (buffer ? frameArray(buffer, frameCum) : null);

  function exportPly() {
    if (!buffer) return;
    downloadBlob(packedToPly(buffer, frameArrayFull() ?? undefined), `${runId || "gaussians"}.ply`);
    setStatus("exported .ply");
  }

  // Export the live gaussians as an .npz matching the data contract
  // (mean_xyz, color_rgb, opacity, scale_xyz, rotation_xyzw, source_frame_index).
  function exportNpz() {
    if (!buffer) return;
    const dv = viewOf(buffer);
    const slots = buffer.length / 8;
    const liveIdx: number[] = [];
    for (let i = 0; i < slots; i++) if (dv.getUint8(i * 32 + 31) !== 0) liveIdx.push(i);
    const n = liveIdx.length;
    const mean = new Float32Array(n * 3), color = new Float32Array(n * 3), opacity = new Float32Array(n);
    const scaleA = new Float32Array(n * 3), rot = new Float32Array(n * 4), frame = new Int32Array(n);
    const frames = frameArrayFull();
    const cov = [0, 0, 0, 0, 0, 0];
    for (let j = 0; j < n; j++) {
      const i = liveIdx[j], b = i * 32;
      mean[j * 3] = dv.getFloat32(b, true); mean[j * 3 + 1] = dv.getFloat32(b + 4, true); mean[j * 3 + 2] = dv.getFloat32(b + 8, true);
      color[j * 3] = dv.getUint8(b + 28) / 255; color[j * 3 + 1] = dv.getUint8(b + 29) / 255; color[j * 3 + 2] = dv.getUint8(b + 30) / 255;
      opacity[j] = dv.getUint8(b + 31) / 255;
      readCov6(dv, b, cov);
      const { scale: s, quaternion: q } = covarianceToScaleRotation(cov);
      scaleA[j * 3] = s[0]; scaleA[j * 3 + 1] = s[1]; scaleA[j * 3 + 2] = s[2];
      rot[j * 4] = q[1]; rot[j * 4 + 1] = q[2]; rot[j * 4 + 2] = q[3]; rot[j * 4 + 3] = q[0]; // wxyz -> xyzw
      frame[j] = frames ? frames[i] : -1;
    }
    const npz = makeNpz([
      { name: "mean_xyz.npy", bytes: npyBytes("<f4", [n, 3], mean) },
      { name: "color_rgb.npy", bytes: npyBytes("<f4", [n, 3], color) },
      { name: "opacity.npy", bytes: npyBytes("<f4", [n], opacity) },
      { name: "scale_xyz.npy", bytes: npyBytes("<f4", [n, 3], scaleA) },
      { name: "rotation_xyzw.npy", bytes: npyBytes("<f4", [n, 4], rot) },
      { name: "source_frame_index.npy", bytes: npyBytes("<i4", [n], frame) },
    ]);
    downloadBlob(npz, `${runId || "gaussians"}.npz`);
    setStatus(`exported .npz (${n} gaussians)`);
  }

  // Export only the selected gaussians as a .ply.
  function exportSelectionPly() {
    if (!buffer || selection.size === 0) return;
    const sel = [...selection];
    const out = new Uint32Array(sel.length * 8);
    for (let j = 0; j < sel.length; j++) out.set(buffer.subarray(sel[j] * 8, sel[j] * 8 + 8), j * 8);
    downloadBlob(packedToPly(out), `${runId || "gaussians"}_sel.ply`);
    setStatus(`exported ${sel.length} selected (.ply)`);
  }

  // Load a local .ply / .splat file into the viewer (no server needed). Clears
  // the view before the await so the camera refits to the new file; restores
  // the timeline when the file carries frame info.
  function onPlyFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-picking the same file
    if (file) loadLocalFile(file);
  }
  async function loadLocalFile(file: File) {
    setBusy(true); setStatus(`reading ${file.name}…`);
    setBuffer(null); setSh1(null); setBounds(null); setSelection(new Set()); setUndoStack([]); setRedoStack([]);
    setLiveBuffer(null); setVis({ mode: "all", set: new Set() }); setFrameCum(null);
    setPlaying(false); setCamDone(false); setGroups([]); pendingView.current = null;
    try {
      const isSplat = /\.splat$/i.test(file.name);
      const isSpz = /\.spz$/i.test(file.name);
      // The spz decoder is code-split (dynamic import) — it's only pulled in
      // when someone actually opens a .spz, keeping it off the initial bundle.
      let { buffer: b, frameCum: fc, sh1: sh } = isSpz
        ? { ...(await (await import("./lib/spz")).spzToPacked(await file.arrayBuffer(), true)), frameCum: null as number[] | null }
        : isSplat
          ? { buffer: splatToPacked(await file.arrayBuffer(), true), frameCum: null as number[] | null, sh1: null as Uint32Array | null }
          : parsePly(await file.arrayBuffer());
      if (loadDiv > 1) {
        b = subsamplePacked(b, loadDiv);
        sh = sh ? subsamplePacked(sh, loadDiv) : sh;
        fc = null; // frame boundaries don't survive subsampling
      }
      setBuffer(b); setSh1(sh); setBounds(computeBounds(b));
      originalBuffer.current = b; // shared, not copied — edits are copy-on-write
      sourceRef.current = { kind: "local" };
      if (fc) { setFrameCum(fc); setFrameIdx(fc.length - 1); setClipIn(0); setClipOut(fc.length - 1); }
      setStatus(`loaded ${file.name}: ${b.length / 8} gaussians${fc ? ` · ${fc.length} frames` : ""}${isSpz ? " · spz(β)" : ""}`);
    } catch (err) {
      setStatus("ply error: " + (err as Error).message);
    } finally { setBusy(false); }
  }

  // Load a public demo scene (.splat from the Hugging Face CDN) — no server or
  // local file needed. Same reset flow as onPlyFile so the camera refits.
  async function loadTestScene(scene: { name: string; file: string }) {
    setBusy(true); setStatus(`${scene.name} 다운로드 중…`);
    setBuffer(null); setSh1(null); setBounds(null); setSelection(new Set()); setUndoStack([]); setRedoStack([]);
    setLiveBuffer(null); setVis({ mode: "all", set: new Set() }); setFrameCum(null);
    setPlaying(false); setCamDone(false); setGroups([]); pendingView.current = null;
    setLive(false); liveCtxRef.current = null;
    try {
      let lastPct = -1;
      // Streams the download straight into the packed buffer (records are
      // converted as chunks arrive) — peak memory ~1x payload, so 200MB-class
      // scenes load without killing the tab.
      const b = await fetchSplatToPacked(TEST_SCENE_CDN + scene.file, true /* COLMAP y-down -> viewer z-up */, (loaded, total, splats) => {
        const mb = (loaded / 1048576).toFixed(1);
        const pct = total > 0 ? Math.floor((loaded / total) * 100) : -1;
        if (pct !== lastPct) { // throttle status updates to 1% steps
          lastPct = pct;
          setStatus(pct >= 0 ? `${scene.name} ${pct}% (${mb} MB · ${splats.toLocaleString()} splats)` : `${scene.name} ${mb} MB · ${splats.toLocaleString()} splats…`);
        }
      }, loadDiv);
      setRunId(scene.name);
      setBuffer(b); setBounds(computeBounds(b));
      originalBuffer.current = b; // shared, not copied — edits are copy-on-write
      sourceRef.current = { kind: "test", file: scene.file };
      recordRecent({ k: "test", f: scene.file, label: scene.name });
      if (pendingSel.current) { setSelection(new Set(pendingSel.current)); pendingSel.current = null; }
      setStatus(`${scene.name}: ${(b.length / 8).toLocaleString()} gaussians`);
    } catch (err) {
      setStatus(`테스트 씬 오류: ${(err as Error).message} (네트워크/CORS 확인)`);
    } finally { setBusy(false); }
  }

  // Multi-run compare: overlay any number of loaded runs / PLY files, each with
  // its own x-offset, visibility, and remove. "편집" swaps one in as the main
  // (editable) buffer so the existing double-click / drag selection works on it.
  function addCompare(name: string, b: Uint32Array) {
    setCompares((cs) => [...cs, { id: compareIdRef.current++, name, buffer: b, visible: true }]);
  }
  async function loadCompare() {
    if (!run2) return;
    setBusy2(true); setStatus(`compare: fetching ${run2}…`);
    try {
      const b = npzToPacked(await unzipNpz(await getSnapshot(host, run2)));
      addCompare(run2, b);
      setStatus(`compare: ${run2} — ${b.length / 8} gaussians`);
    } catch (e) {
      setStatus("compare error: " + (e as Error).message);
    } finally { setBusy2(false); }
  }
  async function onCompareFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setBusy2(true); setStatus(`compare: reading ${file.name}…`);
    try {
      const { buffer: b } = parsePly(await file.arrayBuffer());
      addCompare(file.name, b);
      setStatus(`compare: ${file.name} — ${b.length / 8} gaussians`);
    } catch (err) {
      setStatus("compare error: " + (err as Error).message);
    } finally { setBusy2(false); }
  }
  // Difference heatmap: recolour the MAIN scene by distance to the nearest
  // gaussian in the overlay (spatial hash, capped at 5% of the scene radius).
  // Blue = unchanged, red = no counterpart nearby. Undoable (colour edit).
  async function diffHeatmap(item: CompareItem) {
    if (!buffer || !bounds) return;
    const src = buffer;
    setStatus(`Δ 히트맵 계산 중… (${item.name})`);
    // Runs in a worker for big scenes (identical result, sync fallback), so the
    // nearest-neighbour scan doesn't freeze the UI.
    const nb = await computeHeatmap(src, item.buffer, bounds);
    if (rawBufferRef.current !== src) return; // scene changed mid-scan — abandon
    pushUndo(src);
    setBuffer(nb);
    setStatus(`Δ 히트맵: 파랑=일치 · 빨강=차이 (기준 ${item.name}, undo로 복원)`);
  }

  function toggleCompare(id: number) { setCompares((cs) => cs.map((c) => c.id === id ? { ...c, visible: !c.visible } : c)); }
  function removeCompare(id: number) { setCompares((cs) => cs.filter((c) => c.id !== id)); }
  function clearCompare() { setCompares([]); }
  // Replace the whole scene with `b`: it becomes the active/editable main buffer
  // (selection, gizmos, scene-rotation all act on it). Keeps the camera.
  function becomeScene(name: string, b: Uint32Array) {
    sourceRef.current = { kind: "local" };
    setRunId(name);
    setBuffer(b); setSh1(null); setBounds(computeBounds(b));
    originalBuffer.current = b; // shared, not copied — edits are copy-on-write
    setSelection(new Set()); setUndoStack([]); setRedoStack([]); setLiveBuffer(null);
    setVis({ mode: "all", set: new Set() }); setFrameCum(null); setPlaying(false); setGroups([]);
    setSplatKey((k) => k + 1); // remount so the new scene inits + sorts without a camera move
  }
  // Make a compare overlay the scene; the old main is pushed back as an overlay.
  function switchToMain(item: CompareItem) {
    if (!buffer) return;
    const oldMain: CompareItem = { id: compareIdRef.current++, name: runId || "이전 run", buffer, visible: true };
    setCompares((cs) => [oldMain, ...cs.filter((c) => c.id !== item.id)]);
    becomeScene(item.name, item.buffer);
    setStatus(`편집 대상 → ${item.name} (${item.buffer.length / 8} gaussians)`);
  }
  // Merge the current scene + all visible overlays into one buffer.
  function mergeScenes() {
    if (!buffer) return;
    const shown = compares.filter((c) => c.visible);
    if (shown.length === 0) { setStatus("합칠 오버레이가 없음 (보이는 것만 합쳐짐)"); return; }
    const parts = [buffer, ...shown.map((c) => c.buffer)];
    const merged = new Uint32Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) { merged.set(p, o); o += p.length; }
    setCompares((cs) => cs.filter((c) => !c.visible)); // merged ones consumed; hidden ones kept
    becomeScene(runId || "merged", merged);
    setStatus(`씬 합치기: ${parts.length}개 → ${merged.length / 8} gaussians`);
  }

  // Timeline auto-play: advance the scrub frame, looping within the [in,out] clip.
  React.useEffect(() => {
    if (!playing || !frameCum) return;
    const a = Math.min(clipIn, clipOut), b = Math.max(clipIn, clipOut);
    const id = setInterval(() => setFrameIdx((i) => (i >= b ? a : i + 1)), 1000 / Math.max(0.1, fps));
    return () => clearInterval(id);
  }, [playing, fps, clipIn, clipOut, frameCum]);

  // Export only the gaussians added within the clip range [in,out] as a .ply.
  // Per-gaussian frame indices are rebased to start at 0 so the clip replays.
  function exportRangePly() {
    if (!buffer || !frameCum) return;
    const a = Math.min(clipIn, clipOut), b = Math.max(clipIn, clipOut);
    const lo = a > 0 ? frameCum[a - 1] : 0;
    const hi = frameCum[b];
    if (hi <= lo) return;
    const full = frameArrayFull();
    let frames: Uint32Array | undefined;
    if (full) {
      frames = new Uint32Array(hi - lo);
      for (let j = 0; j < hi - lo; j++) frames[j] = Math.max(0, full[lo + j] - a);
    }
    downloadBlob(packedToPly(buffer.subarray(lo * 8, hi * 8), frames), `${runId || "gaussians"}_f${a}-${b}.ply`);
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

  // Only scan when the stats panel is open. Distribution histograms (opacity +
  // splat size) are sub-sampled inside computeSceneStats.
  const stats = React.useMemo(
    () => (showStats && buffer && bounds ? computeSceneStats(buffer, bounds) : null),
    [showStats, buffer, bounds],
  );

  function undo() {
    if (undoStack.length === 0 || !buffer) return;
    const prev = undoStack[undoStack.length - 1];
    setRedoStack((r) => trimStack([...r, buffer]));
    setUndoStack((s) => s.slice(0, -1));
    setBuffer(prev); setBounds(computeBounds(prev)); setLiveBuffer(null);
    setSplatKey((k) => k + 1);
  }
  function redo() {
    if (redoStack.length === 0 || !buffer) return;
    const next = redoStack[redoStack.length - 1];
    setUndoStack((s) => trimStack([...s, buffer]));
    setRedoStack((r) => r.slice(0, -1));
    setBuffer(next); setBounds(computeBounds(next)); setLiveBuffer(null);
    setSplatKey((k) => k + 1);
  }
  function reset() {
    const ob = originalBuffer.current;
    if (!ob) return;
    // No copy: edits are copy-on-write, so handing back the original is safe.
    setBuffer(ob); setBounds(computeBounds(ob));
    setSelection(new Set()); setUndoStack([]); setRedoStack([]); setLiveBuffer(null); setGroups([]);
    setSplatKey((k) => k + 1);
  }

  useKeyboardShortcuts({ undo, redo, del: deleteSelection, clearSel: () => setSelection(new Set()), hasSel: selection.size > 0 });
  React.useEffect(() => { if (buffer) setLastUpdate(new Date().toLocaleTimeString()); }, [buffer]);

  const display = liveBuffer ?? displayBuffer;

  // Structured empty / error state shown centre-screen when there's no map.
  const emptyState = display ? null
    : busy ? { title: "불러오는 중…", sub: status, err: false }
    : /error/i.test(status) ? { title: "오류", sub: status, err: true }
    : serverOk === false ? { title: "Viewer Server에 연결할 수 없음", sub: "host 주소를 확인하고 다시 시도하세요.", err: true }
    : { title: "표시할 데이터 없음", sub: "run을 선택하고 Load를 누르세요. (또는 도구 ▾ 없이 파일 ▾ → PLY 열기)", err: false };

  // LOD: render only every Nth gaussian when renderFrac < 1 (picking/editing still
  // use the full buffer via bufferRef, so only the drawn/sorted set shrinks).
  const lod = React.useMemo(
    () => (display ? subsampleForLod(display, renderFrac) : display),
    [display, renderFrac],
  );

  // SH side buffer follows the LOD subsampling (same stride) so it stays
  // index-aligned with what's actually drawn.
  const lodSh = React.useMemo(
    () => (sh1 && display ? subsampleShForLod(sh1, display.length, renderFrac) : null),
    [sh1, display, renderFrac],
  );

  const effDpr = dprAuto ? autoDprValue : dpr;

  // Derived render settings: the distance-LOD slider is in scene-radius units;
  // the shader wants world units.
  const settingsDerived = React.useMemo<RenderSettings>(() => ({
    ...settings,
    lodDistWorld: settings.lodDist > 0 && bounds ? settings.lodDist * radius(bounds) : 0,
  }), [settings, bounds]);

  // Move the camera to look at the data centre from `dir` (centre -> camera).
  function setView(dir: [number, number, number]) {
    if (!bounds || !camApiRef.current) return;
    const c = center(bounds), D = radius(bounds) * 2.75 + 1;
    const L = Math.hypot(dir[0], dir[1], dir[2]) || 1;
    camApiRef.current.apply([c[0] + (dir[0] / L) * D, c[1] + (dir[1] / L) * D, c[2] + (dir[2] / L) * D], c);
  }

  // Camera bookmarks: save / restore / delete the current view (persisted).
  async function saveBookmark() {
    const v = camApiRef.current?.get();
    if (!v) return;
    let thumb: string | undefined;
    try {
      const blob = await captureBlobRef.current?.();
      if (blob) {
        const bmp = await createImageBitmap(blob);
        const W = 120, H = 68;
        const c = document.createElement("canvas");
        c.width = W; c.height = H;
        const ctx = c.getContext("2d")!;
        // cover-crop so the thumb isn't squished
        const s2 = Math.max(W / bmp.width, H / bmp.height);
        const sw = W / s2, sh = H / s2;
        ctx.drawImage(bmp, (bmp.width - sw) / 2, (bmp.height - sh) / 2, sw, sh, 0, 0, W, H);
        bmp.close();
        thumb = c.toDataURL("image/jpeg", 0.6);
      }
    } catch { /* thumbnail is optional */ }
    setBookmarks((b) => [...b, { ...v, thumb }]);
    setStatus("북마크 저장됨");
  }
  function restoreBookmark(i: number) {
    const v = bookmarks[i];
    if (v) { setTouring(false); camApiRef.current?.apply(v.p, v.t); }
  }
  function deleteBookmark(i: number) {
    setBookmarks((b) => b.filter((_, j) => j !== i));
  }
  // Reorder a bookmark up (-1) / down (+1) — sets the tour order too.
  function moveBookmark(i: number, dir: -1 | 1) {
    setBookmarks((b) => {
      const j = i + dir;
      if (j < 0 || j >= b.length) return b;
      const next = b.slice();
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  }
  // Bookmark tour: glide the camera through the bookmarks in order, looping.
  const TOUR_SEG = 2.5; // seconds spent gliding between two bookmarks
  const tourPoses = React.useMemo<CamPose[]>(() => {
    if (bookmarks.length < 2) return [];
    const poses: CamPose[] = bookmarks.map((b, i) => ({ p: b.p, t: b.t, ms: i * TOUR_SEG }));
    poses.push({ ...bookmarks[0], ms: bookmarks.length * TOUR_SEG }); // return to start → seamless loop
    return poses;
  }, [bookmarks]);
  function bookmarkTour() {
    if (bookmarks.length < 2) { setStatus("북마크가 2개 이상이어야 순회 가능"); return; }
    setCamReplaying(false); setCamRecording(false); setAutoOrbit(false); setCamSeekMs(0);
    setTouring(true);
  }

  // Camera path record / replay.
  function toggleCamRecord() {
    if (camRecording) {
      setCamRecording(false);
      setCamPath(camRecRef.current.slice());
      setStatus(`카메라 경로 녹화됨 (${camRecRef.current.length} keyframes)`);
    } else {
      setCamReplaying(false); setTouring(false);
      setCamRecording(true);
      setStatus("카메라 경로 녹화 중… (카메라를 움직이세요)");
    }
  }
  function playCamPath() {
    if (camPath.length < 2) { setStatus("녹화된 카메라 경로가 없음"); return; }
    setCamRecording(false); setTouring(false);
    setCamReplaying(true);
  }

  // --- Video export (WebM) via canvas.captureStream + MediaRecorder ---
  function startVideoRecording(name: string): boolean {
    const canvas = canvasRef.current;
    if (!canvas || typeof MediaRecorder === "undefined" || !canvas.captureStream) {
      setStatus("이 브라우저는 영상 녹화를 지원하지 않음"); return false;
    }
    const mime = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"]
      .find((t) => MediaRecorder.isTypeSupported(t)) || "";
    const rec = new MediaRecorder(canvas.captureStream(30), mime ? { mimeType: mime, videoBitsPerSecond: 12_000_000 } : undefined);
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    rec.onstop = () => { downloadBlob(new Blob(chunks, { type: rec.mimeType || "video/webm" }), name); setVideoRec(false); videoRecRef.current = null; };
    rec.start();
    videoRecRef.current = rec; setVideoRec(true);
    return true;
  }
  function stopVideoRecording() {
    if (turntableTimer.current) { clearTimeout(turntableTimer.current); turntableTimer.current = null; }
    setAutoOrbit(false); setCamReplaying(false);
    videoRecRef.current?.stop();
  }
  // Record a flythrough of the recorded camera path (auto-stops at path end).
  function exportFlythrough() {
    if (camPath.length < 2) { setStatus("녹화된 카메라 경로가 없음 (먼저 경로 녹화)"); return; }
    if (!startVideoRecording(`${runId || "viser"}_flythrough.webm`)) return;
    setCamRecording(false); setTouring(false); setCamSeekMs(0); setCamReplaying(true);
  }
  // Record one full turntable revolution (auto-stops after ~360°).
  function exportTurntable() {
    if (!buffer) return;
    if (!startVideoRecording(`${runId || "viser"}_turntable.webm`)) return;
    setCamReplaying(false); setTouring(false); setAutoOrbit(true);
    const durMs = (2 * Math.PI / autoOrbitSpeed) * 1000 * 1.05 + 200;
    turntableTimer.current = window.setTimeout(() => { setAutoOrbit(false); videoRecRef.current?.stop(); }, durMs);
  }

  // Toggling MSAA needs a fresh WebGL context (Canvas remount via key), which
  // resets the camera — stash the current view so ApplyCamera restores it.
  function toggleAntialias(v: boolean) {
    const cur = camApiRef.current?.get();
    if (cur && buffer) pendingView.current = { p: cur.p, t: cur.t };
    setAntialias(v);
  }

  // Offline high-quality frame export: step the camera pose frame-by-frame,
  // render + capture each PNG deterministically (independent of realtime fps),
  // and download the sequence as a ZIP (30fps timing; ffmpeg-ready).
  async function exportFramesZip(kind: "path" | "turntable") {
    const cap = captureBlobRef.current, cam = camApiRef.current;
    if (!buffer || !bounds || videoRec || !cap || !cam) return;
    const FPS = 30;
    const poses: { p: [number, number, number]; t: [number, number, number] }[] = [];
    if (kind === "path") {
      if (camPath.length < 2) { setStatus("녹화된 카메라 경로가 없음 (먼저 경로 녹화)"); return; }
      const dur = camPath[camPath.length - 1].ms;
      const frames = Math.min(450, Math.max(2, Math.ceil(dur * FPS)));
      for (let f = 0; f < frames; f++) {
        const p = poseAt(camPath, (f / (frames - 1)) * dur);
        if (p) poses.push({ p: p.p, t: p.t });
      }
    } else {
      // One full turn around the scene centre at the current radius/height.
      const v = cam.get(); const c = center(bounds);
      const rx = v.p[0] - c[0], ry = v.p[1] - c[1];
      const frames = 240; // 8s @ 30fps
      for (let f = 0; f < frames; f++) {
        const a = (f / frames) * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
        poses.push({ p: [c[0] + rx * ca - ry * sa, c[1] + rx * sa + ry * ca, v.p[2]], t: [c[0], c[1], c[2]] });
      }
    }
    setBusy(true); setCamReplaying(false); setAutoOrbit(false); setTouring(false);
    const restore = cam.get();
    try {
      const entries: { name: string; bytes: Uint8Array }[] = [];
      for (let i = 0; i < poses.length; i++) {
        cam.apply(poses[i].p, poses[i].t);
        await new Promise((r) => requestAnimationFrame(r)); // settle controls + regular frame
        const blob = await cap();
        if (!blob) throw new Error("캡처 실패");
        entries.push({ name: `frame_${String(i).padStart(4, "0")}.png`, bytes: new Uint8Array(await blob.arrayBuffer()) });
        if (i % 10 === 0 || i === poses.length - 1) setStatus(`고품질 프레임 렌더 ${i + 1}/${poses.length}…`);
      }
      downloadBlob(makeNpz(entries), `${runId || "viser"}_${kind}_30fps_frames.zip`);
      setStatus(`프레임 ${poses.length}장 ZIP 저장 (30fps) — ffmpeg -framerate 30 -i frame_%04d.png 으로 영상화`);
    } catch (e) {
      setStatus("프레임 내보내기 오류: " + (e as Error).message);
    } finally {
      cam.apply(restore.p, restore.t);
      setBusy(false);
    }
  }

  // High-res screenshot: briefly pin DPR above the current effective value,
  // let it render, capture, then restore (including auto mode).
  function captureHiRes(scale: number) {
    if (!buffer) return;
    const prevAuto = dprAuto, prevDpr = dpr;
    setDprAuto(false);
    setDpr(Math.min(effDpr * scale, 8));
    setStatus(`${scale}× 스크린샷 렌더링…`);
    window.setTimeout(() => {
      captureRef.current?.(`${runId || "viser"}_${scale}x.png`);
      setDpr(prevDpr); setDprAuto(prevAuto);
      setStatus(`${scale}× 스크린샷 저장됨`);
    }, 200);
  }

  // Put the camera at the world origin (where the axes gizmo sits — usually the
  // capture/reference origin), facing AWAY from the data centre (the capture's
  // forward direction is typically opposite the reconstructed content).
  function cameraToOrigin() {
    if (!bounds || !camApiRef.current) return;
    const c = center(bounds);
    camApiRef.current.apply([0, 0, 0], Math.hypot(c[0], c[1], c[2]) < 1e-4 ? [0, 1, 0] : [-c[0], -c[1], -c[2]]);
    setStatus("카메라 → 원점(축)");
  }

  const hasTimeline = !!(frameCum && frameCum.length > 1);
  const timelineVisible = hasTimeline && showTimeline;
  const clipA = Math.min(clipIn, clipOut), clipB = Math.max(clipIn, clipOut);
  const tlPct = (i: number) => (hasTimeline ? (i / (frameCum!.length - 1)) * 100 : 0);
  const rangeCount = frameCum ? frameCum[clipB] - (clipA > 0 ? frameCum[clipA - 1] : 0) : 0;

  return (
    <div
      style={{ position: "fixed", inset: 0 }}
      onDragEnter={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        dragDepth.current++;
        setDragOver(true);
      }}
      onDragOver={(e) => { if (e.dataTransfer.types.includes("Files")) e.preventDefault(); }}
      onDragLeave={() => { if (--dragDepth.current <= 0) { dragDepth.current = 0; setDragOver(false); } }}
      onDrop={(e) => {
        e.preventDefault();
        dragDepth.current = 0;
        setDragOver(false);
        const f = e.dataTransfer.files?.[0];
        if (!f) return;
        if (/\.(ply|splat|spz)$/i.test(f.name)) loadLocalFile(f);
        else setStatus("지원하지 않는 파일 — .ply / .splat만");
      }}
    >
      <div className={"panel toolbar" + (menuOpen ? "" : " collapsed")}>
        <button className="hamburger icon" onClick={() => setMenuOpen((o) => !o)} title="메뉴">{menuOpen ? "✕" : "☰"}</button>
        <input value={host} onChange={(e) => setHost(e.target.value)} placeholder="(empty = this server)" className="grow menu-only" style={{ minWidth: 120 }} />
        <select value={runId} onChange={(e) => setRunId(e.target.value)} className="menu-only" style={{ flex: 2, minWidth: 160 }}>
          {runs.length === 0 && <option value={runId}>{runId}</option>}
          {runs.map((r) => <option key={r.runId} value={r.runId}>{r.runId} ({r.gaussians})</option>)}
        </select>
        <select value={mode} onChange={(e) => setMode(e.target.value as "snapshot" | "delta")} className="menu-only">
          <option value="snapshot">snapshot</option>
          <option value="delta">delta</option>
        </select>
        {mode === "delta" && <input value={maxFrames} onChange={(e) => setMaxFrames(e.target.value)} title="max delta frames" className="menu-only" style={{ width: 56 }} />}
        <button className="accent" onClick={() => load()} disabled={busy}>{busy ? "…" : "Load"}</button>
        <input ref={fileRef} type="file" accept=".ply,.splat,.spz" style={{ display: "none" }} onChange={onPlyFile} />
        <Dropdown label="파일" className="menu-only">
          <button onClick={() => fileRef.current?.click()} disabled={busy}>PLY/SPLAT/SPZ 열기</button>
          <button onClick={exportPly} disabled={!buffer}>.ply 내보내기</button>
          <button onClick={exportNpz} disabled={!buffer}>.npz 내보내기</button>
          <button onClick={() => captureRef.current?.(`${runId || "viser"}.png`)} disabled={!buffer}>스크린샷 (PNG)</button>
          <button onClick={() => captureHiRes(2)} disabled={!buffer}>스크린샷 2×</button>
          <button onClick={() => captureHiRes(4)} disabled={!buffer}>스크린샷 4×</button>
          <button onClick={share} disabled={!buffer}>URL 공유</button>
          {recents.length > 0 && <hr className="divider" />}
          {recents.map((r) => (
            <button key={r.k === "test" ? `t:${r.f}` : `r:${r.host}|${r.run}`} disabled={busy}
              title={r.k === "test" ? "CDN 테스트 씬 다시 열기" : "서버 run 다시 열기"}
              onClick={() => {
                if (r.k === "test") {
                  loadTestScene(TEST_SCENES.find((sc) => sc.file === r.f) ?? { name: r.label, file: r.f });
                } else {
                  setHost(r.host); setRunId(r.run); setMode(r.mode); setMaxFrames(r.maxFrames);
                  load({ host: r.host, runId: r.run, mode: r.mode, maxFrames: r.maxFrames });
                }
              }}>
              🕘 {r.label}
            </button>
          ))}
        </Dropdown>
        <Dropdown label="테스트" className="menu-only">
          {TEST_SCENES.map((s) => (
            <button key={s.file} onClick={() => loadTestScene(s)} disabled={busy} title={`${TEST_SCENE_CDN}${s.file}`}>
              {s.name}{s.big ? " (대용량)" : ""}
            </button>
          ))}
        </Dropdown>
        <button onClick={undo} disabled={undoStack.length === 0}>undo</button>
        <button onClick={redo} disabled={redoStack.length === 0}>redo</button>
        <button onClick={reset} disabled={!originalBuffer.current}>reset</button>
        {selection.size > 0 && <button className="menu-only" onClick={() => setSelection(new Set())}>clear ({selection.size})</button>}
        {vis.mode !== "all" && <button className="menu-only" onClick={showAll}>전체 보기</button>}
        <Dropdown label={`도구${measureMode || polyMode || showFilter || showGroups || showCompare || compares.length ? " ●" : ""}`} className="menu-only">
          <button className={measureMode ? "active" : ""} onClick={() => { setMeasureMode((m) => !m); setMeasurePts([]); setPolyMode(false); setPolyPts([]); setNoteMode(false); }} disabled={!buffer}>측정</button>
          <button className={polyMode ? "active" : ""} onClick={togglePolyMode} disabled={!buffer} title="가우시안을 꼭짓점으로 찍어 입체 다면체를 만들고 (최소 4점), 그 안의 가우시안을 전부 선택">◆ 다면체 선택</button>
          <button className={noteMode ? "active" : ""} disabled={!buffer}
            title="가우시안을 더블클릭해 3D 주석(핀+메모)을 답니다 — 공유 링크에 포함됨"
            onClick={() => setNoteMode((m) => { if (!m) { setMeasureMode(false); setPolyMode(false); setPolyPts([]); } return !m; })}>📌 주석{notes.length ? ` (${notes.length})` : ""}</button>
          <button className={showFilter ? "active" : ""} onClick={() => setShowFilter((v) => !v)} disabled={!buffer}>필터</button>
          <button className={showGroups ? "active" : ""} onClick={() => setShowGroups((v) => !v)} disabled={!buffer}>그룹{groups.length > 0 ? ` (${groups.length})` : ""}</button>
          <button className={showCompare ? "active" : ""} onClick={() => setShowCompare((v) => !v)} disabled={!buffer}>비교{compares.length ? ` (${compares.length})` : ""}</button>
          <button className={showCrop ? "active" : ""} onClick={() => (showCrop ? closeCrop() : openCrop())} disabled={!buffer} title="박스 밖을 미리보기로 숨기고, 확정 시 삭제">✂ 크롭 박스</button>
          <button onClick={cleanFloaters} disabled={!buffer} title="주변에 이웃이 거의 없는 떠다니는 노이즈 가우시안을 한 번에 삭제">🧹 플로터 정리</button>
        </Dropdown>
        <button className={"menu-only" + (showCamPanel || autoOrbit || camRecording || camReplaying ? " active" : "")} onClick={() => setShowCamPanel((v) => !v)} disabled={!buffer}>카메라{autoOrbit || camRecording ? " ●" : ""}</button>
        {hasTimeline && <button className={showTimeline ? "active" : ""} onClick={() => setShowTimeline((v) => !v)}>타임라인</button>}
        {hasTimeline && <button className={live ? "active" : ""} onClick={() => setLive((v) => !v)} title="새 delta 프레임 자동 폴링">{live ? "● 라이브" : "라이브"}</button>}
        <button className="menu-only" onClick={() => setShowStats((v) => !v)}>통계</button>
        <button className="ghost icon menu-only" onClick={() => setShowHelp((v) => !v)}>?</button>
        <button className="ghost icon menu-only" onClick={() => setShowPanel((v) => !v)}>⚙</button>
        <span className="grow" />
        <span ref={fpsElRef} className="num" style={{ whiteSpace: "nowrap", color: "#33e08a" }} title="렌더 fps · 평균 프레임 시간" />
      </div>

      {showPanel && (
        <SettingsPanel
          settings={settings}
          setSettings={setSettings}
          scene={{ bg, setBg, showMap, setShowMap, showGrid, setShowGrid, grid, setGrid, dpr, setDpr, dprAuto, setDprAuto, effDpr, antialias, setAntialias: toggleAntialias, rotateSens, setRotateSens, zoomSens, setZoomSens, moveSens, setMoveSens, minFps, setMinFps, undoCapMB, setUndoCapMB, loadDiv, setLoadDiv, reloadRenderer: () => setSplatKey((k) => k + 1), showAxes, setShowAxes, renderFrac, setRenderFrac, setView, cameraToOrigin, rotateScene, clipSweep, setClipSweep, bounds }}
          onClose={() => setShowPanel(false)}
        />
      )}

      {showHelp && (
        <FloatingPanel title="📖 사용 방법" onClose={() => setShowHelp(false)} style={{ left: 10, bottom: timelineVisible ? 112 : 10 }} width="min(420px, calc(100vw - 20px))">
          {HELP.map(([k, v]) => (
            <div key={k} className="row" style={{ alignItems: "baseline" }}>
              <span className="kbd">{k}</span><span className="muted">{v}</span>
            </div>
          ))}
        </FloatingPanel>
      )}

      {selection.size > 0 && !measureMode && (
        <SelectionPanel
          selectionSize={selection.size}
          onDeselect={() => setSelection(new Set())} onInvert={invertSelection} onGrow={growSelection}
          moveStep={moveStep} setMoveStep={setMoveStep} onMove={moveSelection}
          rotStep={rotStep} setRotStep={setRotStep} onRotate={rotateSelection}
          onScaleUniform={scaleSelection} onScaleAxis={scaleSelectionXYZ}
          editColor={editColor} setEditColor={setEditColor} editAlpha={editAlpha} setEditAlpha={setEditAlpha} onApplyColor={applyColorOpacity}
          onDuplicate={duplicateSelection} onHide={hideSelection} onIsolate={isolateSelection} onDelete={deleteSelection} onKeepOnly={keepOnlySelection} onExportSel={exportSelectionPly}
          onPivot={() => { if (buffer && selection.size > 0) { camApiRef.current?.setTarget(selCenter(buffer, selection)); setStatus("회전축 → 선택 중심"); } }}
        />
      )}

      {polyMode && (
        <FloatingPanel title="◆ 다면체 선택" onClose={() => { setPolyMode(false); setPolyPts([]); }} style={{ top: 64, left: "50%", transform: "translateX(-50%)" }} width="min(340px, calc(100vw - 20px))">
          <span className="muted" style={{ fontSize: 12 }}>가우시안을 더블클릭해 꼭짓점을 찍으세요 ({polyPts.length}점 · 4점부터 다면체) — 점은 씬에 고정되니 카메라를 돌려가며 찍어도 됩니다</span>
          <label className="row"><input type="checkbox" checked={polyAdd} onChange={(e) => setPolyAdd(e.target.checked)} /> 기존 선택에 추가</label>
          <div className="row" style={{ gap: 6 }}>
            <button className="grow" onClick={() => setPolyPts((p) => p.slice(0, -1))} disabled={polyPts.length === 0}>↩ 마지막 점</button>
            <button className="grow ghost" onClick={() => setPolyPts([])} disabled={polyPts.length === 0}>지우기</button>
          </div>
          <button className="accent" onClick={runPolySelect} disabled={polyPts.length < 4}>✓ 다면체 안 선택</button>
          <button onClick={saveRegion} disabled={polyPts.length < 4} title="현재 다면체를 저장해 두고 나중에 다시 선택에 사용">💾 영역 저장</button>
          {savedRegions.length > 0 && <hr className="divider" />}
          {savedRegions.map((r) => (
            <div key={r.id} className="row" style={{ gap: 5 }}>
              <span className="grow" style={{ overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>{r.name} · {r.pts.length}점</span>
              <button onClick={() => hullSelect(r.pts, false)} title="이 영역 안을 선택">선택</button>
              <button onClick={() => hullSelect(r.pts, true)} title="기존 선택에 추가">＋</button>
              <button className="ghost icon" onClick={() => setPolyPts(r.pts)} title="다면체를 편집기로 불러오기">✎</button>
              <button className="ghost icon" onClick={() => setSavedRegions((rs) => rs.filter((x) => x.id !== r.id))} title="삭제">✕</button>
            </div>
          ))}
        </FloatingPanel>
      )}


      {noteMode && (
        <FloatingPanel title="📌 주석" onClose={() => setNoteMode(false)} style={{ top: 64, left: "50%", transform: "translateX(-50%)" }} width="min(340px, calc(100vw - 20px))">
          <span className="muted" style={{ fontSize: 12 }}>가우시안을 더블클릭하면 메모를 답니다 — 공유 링크에 포함됩니다 (최대 20개)</span>
          {notes.map((n) => (
            <div key={n.id} className="row" style={{ gap: 5 }}>
              <span className="grow" style={{ overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>📌 {n.text}</span>
              <button className="ghost icon" onClick={() => camApiRef.current?.setTarget(n.p)} title="이 주석을 회전축으로">🎯</button>
              <button className="ghost icon" onClick={() => setNotes((ns) => ns.filter((x) => x.id !== n.id))} title="삭제">✕</button>
            </div>
          ))}
          {notes.length > 0 && <button className="ghost" onClick={() => setNotes([])}>모두 지우기</button>}
        </FloatingPanel>
      )}

      {measureMode && (
        <FloatingPanel title="📏 측정 (다점)" onClose={() => { setMeasureMode(false); setMeasurePts([]); }} style={{ top: 64, left: "50%", transform: "translateX(-50%)" }} width="min(360px, calc(100vw - 20px))">
          <span className="muted">가우시안을 더블클릭해 점을 이어가세요 ({measurePts.length}점)</span>
          {measureTotal != null && (
            <span className="num" style={{ fontSize: 17, color: "var(--accent-2)" }}>
              총 길이: {measureTotal.toFixed(3)}{measurePts.length > 2 && measureLast != null ? ` (마지막 구간 ${measureLast.toFixed(3)})` : ""}
            </span>
          )}
          {measurePts.length > 0 && (
            <div className="row" style={{ gap: 6 }}>
              <button className="grow" onClick={() => setMeasurePts((p) => p.slice(0, -1))}>↩ 마지막 점 취소</button>
              <button className="grow ghost" onClick={() => setMeasurePts([])}>지우기</button>
            </div>
          )}
        </FloatingPanel>
      )}

      {showFilter && (
        <FilterPanel
          onClose={() => setShowFilter(false)} filterAdd={filterAdd} setFilterAdd={setFilterAdd}
          filterColor={filterColor} setFilterColor={setFilterColor} onPickColor={pickColorFromSelection} canPick={selection.size > 0}
          filterTol={filterTol} setFilterTol={setFilterTol} onFilterColor={filterByColor}
          filterOpMin={filterOpMin} setFilterOpMin={setFilterOpMin} filterOpMax={filterOpMax} setFilterOpMax={setFilterOpMax} onFilterOpacity={filterByOpacity}
        />
      )}

      {showGroups && (
        <GroupPanel
          onClose={() => setShowGroups(false)} selectionSize={selection.size} groups={groups}
          onCreate={createGroup} onSelect={selectGroup} onToggleHide={toggleGroupHide} onRecolor={recolorGroup} onRemove={removeGroup}
        />
      )}

      {showCompare && (
        <FloatingPanel title="⚖ 다중 run 비교" onClose={() => setShowCompare(false)} style={{ top: 62, right: 8 }} width="min(360px, calc(100vw - 20px))">
          <span className="muted" style={{ fontSize: 12 }}>두 번째 대상을 겹쳐 표시 (서버 run 또는 PLY 파일)</span>
          <select value={run2} onChange={(e) => setRun2(e.target.value)}>
            <option value="">(서버 run 선택)</option>
            {runs.map((r) => <option key={r.runId} value={r.runId}>{r.runId} ({r.gaussians})</option>)}
          </select>
          <div className="row" style={{ gap: 6 }}>
            <button className="grow" onClick={loadCompare} disabled={busy2 || !run2}>{busy2 ? "…" : "run 겹쳐 로드"}</button>
            <button className="grow" onClick={() => compareFileRef.current?.click()} disabled={busy2}>PLY로 비교</button>
          </div>
          <button disabled={!buffer || !originalBuffer.current || buffer === originalBuffer.current}
            title="로드 시점의 원본을 오버레이로 올리고 A/B 와이프를 켬 — 편집 전/후를 나란히 비교"
            onClick={() => {
              const ob = originalBuffer.current;
              if (!ob) return;
              addCompare("원본 (편집 전)", ob);
              setSettings((s2) => ({ ...s2, wipeOn: 1 }));
              setStatus("좌: 편집본 · 우: 원본 — 가운데 선을 드래그");
            }}>🅾 편집 전과 A/B 와이프</button>
          <input ref={compareFileRef} type="file" accept=".ply" style={{ display: "none" }} onChange={onCompareFile} />
          {compares.length > 0 && (
            <>
              <hr className="divider" />
              <label className="row" title="화면을 좌(현재 씬) / 우(오버레이)로 나눠 비교 — 가운데 선을 드래그">
                <input type="checkbox" checked={settings.wipeOn === 1}
                  onChange={(e) => setSettings((s) => ({ ...s, wipeOn: e.target.checked ? 1 : 0 }))} />
                A/B 와이프 <span className="muted" style={{ fontSize: 11 }}>(좌: 현재 씬 · 우: 오버레이)</span>
              </label>
              <hr className="divider" />
              <span className="muted" style={{ fontSize: 12 }}>겹친 run · "편집"으로 씬 전환, "합치기"로 하나로</span>
              {compares.map((c) => (
                <div key={c.id} className="row" style={{ gap: 5 }}>
                  <button className="ghost icon" onClick={() => toggleCompare(c.id)} title={c.visible ? "숨기기" : "보이기"}>{c.visible ? "👁" : "🚫"}</button>
                  <span className="grow" style={{ overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis", opacity: c.visible ? 1 : 0.5 }} title={c.name}>{c.name} · {(c.buffer.length / 8).toLocaleString()}</span>
                  <button onClick={() => switchToMain(c)} title="이 run을 편집 대상(씬)으로">편집</button>
                  <button onClick={() => diffHeatmap(c)} title="현재 씬을 이 오버레이와의 거리로 색칠 (파랑=일치, 빨강=차이 · undo로 복원)">Δ</button>
                  <button className="ghost icon" onClick={() => removeCompare(c.id)} title="제거">✕</button>
                </div>
              ))}
              <div className="row" style={{ gap: 6 }}>
                <button className="grow" onClick={mergeScenes} title="현재 씬 + 보이는 오버레이를 하나의 버퍼로 합침">🧩 씬 합치기</button>
                <button className="danger" onClick={clearCompare}>모두 지우기</button>
              </div>
            </>
          )}
        </FloatingPanel>
      )}

      {showCrop && bounds && (
        <FloatingPanel title="✂ 크롭 박스" onClose={closeCrop} style={{ top: 62, right: 8 }} width="min(320px, calc(100vw - 20px))">
          <span className="muted" style={{ fontSize: 12 }}>박스 밖은 실시간으로 숨겨짐 · "밖 삭제"로 확정 (undo 가능)</span>
          {[0, 1, 2].map((ax) => {
            const lo = bounds.min[ax], hi = bounds.max[ax];
            const step = Math.max((hi - lo) / 200, 1e-4);
            return (
              <div key={ax} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                <div className="row" style={{ justifyContent: "space-between" }}>
                  <span className="muted">{"XYZ"[ax]}</span>
                  <span className="num muted" style={{ fontSize: 11 }}>{settings.cropMin[ax].toFixed(2)} ~ {settings.cropMax[ax].toFixed(2)}</span>
                </div>
                <div className="row" style={{ gap: 6 }}>
                  <input type="range" className="grow" min={lo} max={hi} step={step} value={settings.cropMin[ax]}
                    onChange={(e) => setCropVal("cropMin", ax, Math.min(parseFloat(e.target.value), settings.cropMax[ax]))} />
                  <input type="range" className="grow" min={lo} max={hi} step={step} value={settings.cropMax[ax]}
                    onChange={(e) => setCropVal("cropMax", ax, Math.max(parseFloat(e.target.value), settings.cropMin[ax]))} />
                </div>
              </div>
            );
          })}
          <div className="row" style={{ gap: 6 }}>
            <button className="grow danger" onClick={cropDeleteOutside}>✂ 박스 밖 삭제</button>
            <button className="grow" onClick={openCrop} title="박스를 씬 전체로 되돌림">초기화</button>
          </div>
        </FloatingPanel>
      )}

      {showCamPanel && (() => {
        const dur = camPath.length ? camPath[camPath.length - 1].ms : 0;
        return (
          <FloatingPanel title="🎥 카메라" onClose={() => setShowCamPanel(false)} style={{ top: 62, right: 8 }} width="min(250px, calc(100vw - 20px))">
            <label className="row"><input type="checkbox" checked={autoOrbit} onChange={(e) => setAutoOrbit(e.target.checked)} /> 자동 회전 (공전)</label>
            <label className="row muted">속도
              <input type="range" className="grow" min={0.05} max={2} step={0.05} value={autoOrbitSpeed} onChange={(e) => setAutoOrbitSpeed(parseFloat(e.target.value))} />
              <span className="num" style={{ width: 34, textAlign: "right" }}>{autoOrbitSpeed.toFixed(2)}</span>
            </label>
            <hr className="divider" />
            <div className="muted">카메라 경로</div>
            <button className={camRecording ? "danger" : ""} onClick={toggleCamRecord} disabled={!buffer}>{camRecording ? `■ 녹화 정지 (${camRecRef.current.length}f)` : "● 경로 녹화"}</button>
            {camPath.length >= 2 && (
              <>
                <div className="row" style={{ gap: 8 }}>
                  <button className={camReplaying ? "active icon" : "icon"} onClick={() => (camReplaying ? setCamReplaying(false) : playCamPath())}>{camReplaying ? "⏸" : "▶"}</button>
                  <input type="range" className="grow" min={0} max={dur} step={dur / 300 || 0.01} value={Math.min(camSeekMs, dur)} onChange={(e) => { setCamReplaying(false); setCamSeekMs(parseFloat(e.target.value)); }} />
                  <span className="num muted" style={{ whiteSpace: "nowrap" }}>{camSeekMs.toFixed(1)}s</span>
                </div>
                <button className="ghost" onClick={() => { setCamReplaying(false); setCamPath([]); setCamSeekMs(0); }}>경로 지우기</button>
              </>
            )}
            <hr className="divider" />
            <div className="muted">영상 내보내기 (WebM)</div>
            <div className="row" style={{ gap: 6 }}>
              <button className="grow" onClick={exportFlythrough} disabled={camPath.length < 2 || videoRec}>🎬 경로 영상</button>
              <button className="grow" onClick={exportTurntable} disabled={!buffer || videoRec}>🎠 턴테이블</button>
            </div>
            {videoRec && <button className="danger" onClick={stopVideoRecording}>■ 녹화 중지 &amp; 저장</button>}
            <div className="row" style={{ gap: 6 }}>
              <button className="grow" onClick={() => exportFramesZip("path")} disabled={camPath.length < 2 || videoRec || busy} title="경로를 프레임 단위로 렌더해 PNG 시퀀스로 — 실시간 fps와 무관한 고품질">🎞 경로 PNG</button>
              <button className="grow" onClick={() => exportFramesZip("turntable")} disabled={!buffer || videoRec || busy} title="한 바퀴(8초·240프레임)를 프레임 단위로 렌더해 PNG 시퀀스로">🎞 턴테이블 PNG</button>
            </div>
            <span className="muted" style={{ fontSize: 11 }}>고품질 프레임 ZIP (30fps) — 렌더 버벅임과 무관, ffmpeg로 영상화</span>
            <hr className="divider" />
            <div className="row" style={{ justifyContent: "space-between" }}>
              <span className="muted">북마크 (시점)</span>
              {bookmarks.length >= 2 && <button className={touring ? "active icon" : "icon"} onClick={() => (touring ? setTouring(false) : bookmarkTour())} title="북마크를 부드럽게 순회">{touring ? "⏸ 순회" : "▶ 순회"}</button>}
            </div>
            <button onClick={saveBookmark}>＋ 현재 시점 저장</button>
            {bookmarks.map((bm, i) => (
              <div key={i} className="row" style={{ gap: 5 }}>
                <button className="grow" style={{ textAlign: "left", display: "flex", alignItems: "center", gap: 8, padding: 4 }} onClick={() => restoreBookmark(i)} title="이 시점으로 이동">
                  {bm.thumb ? <img src={bm.thumb} alt="" style={{ width: 56, height: 32, objectFit: "cover", borderRadius: 4, flex: "none" }} /> : <span>📌</span>}
                  <span>북마크 {i + 1}</span>
                </button>
                <button className="ghost icon" onClick={() => moveBookmark(i, -1)} disabled={i === 0} title="위로">▲</button>
                <button className="ghost icon" onClick={() => moveBookmark(i, 1)} disabled={i === bookmarks.length - 1} title="아래로">▼</button>
                <button className="ghost icon" onClick={() => deleteBookmark(i)} title="삭제">✕</button>
              </div>
            ))}
          </FloatingPanel>
        );
      })()}

      {timelineVisible && (
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
        <FloatingPanel title="📊 통계" onClose={() => setShowStats(false)} style={{ right: 10, bottom: timelineVisible ? 112 : 10 }} width="min(220px, calc(100vw - 20px))">
            <div className="row" style={{ justifyContent: "space-between" }}><span className="muted">가우시안</span><span className="num">{stats.live.toLocaleString()}{stats.live !== stats.slots && ` / ${stats.slots.toLocaleString()}`}</span></div>
            <div className="row" style={{ justifyContent: "space-between" }}><span className="muted">바운드</span><span className="num">{stats.size.map((v) => v.toFixed(2)).join(" × ")}</span></div>
            <div className="row" style={{ justifyContent: "space-between" }}><span className="muted">선택</span><span className="num">{selection.size.toLocaleString()}</span></div>
            <div className="row" style={{ justifyContent: "space-between" }}><span className="muted">메모리</span><span className="num">{stats.mb.toFixed(1)} MB</span></div>
            {frameCum && (
              <div className="row" style={{ justifyContent: "space-between" }}><span className="muted">프레임</span><span className="num">{frameIdx + 1} / {frameCum.length}</span></div>
            )}
            {frameCum && (
              <div className="row" style={{ justifyContent: "space-between" }}><span className="muted">새 가우시안</span><span className="num">+{(frameCum[frameIdx] - (frameIdx > 0 ? frameCum[frameIdx - 1] : 0)).toLocaleString()}</span></div>
            )}
            {camPose && (
              <>
                <hr className="divider" />
                <div className="row" style={{ justifyContent: "space-between" }}><span className="muted">카메라 위치</span><span className="num" style={{ fontSize: 11 }}>{camPose.p.map((v) => v.toFixed(2)).join(", ")}</span></div>
                <div className="row" style={{ justifyContent: "space-between" }}><span className="muted">카메라 방향</span><span className="num" style={{ fontSize: 11 }}>{camPose.d.map((v) => v.toFixed(2)).join(", ")}</span></div>
                <button onClick={copyCamPose} title="현재 위치/타깃을 JSON으로 복사 (시작 카메라 지정용)">📋 카메라 좌표 복사</button>
                <div className="row" style={{ gap: 6 }}>
                  <input
                    className="grow num" style={{ fontSize: 11, minWidth: 0 }}
                    placeholder='{"p":[x,y,z],"t":[x,y,z]}'
                    value={camPoseInput}
                    onChange={(e) => setCamPoseInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") gotoCamPose(); }}
                  />
                  <button onClick={gotoCamPose} disabled={!camPoseInput.trim()} title="붙여넣은 좌표로 카메라 이동 (JSON 또는 숫자 6개/3개)">이동</button>
                </div>
              </>
            )}
            <hr className="divider" />
            <Hist data={stats.opHist} label="불투명도 분포" sub="0 → 255" />
            <Hist data={stats.sizeHist} label="크기 분포" sub={`0 → ${stats.sizeP95.toPrecision(2)} (p95)`} />
            <hr className="divider" />
            <div className="row" style={{ justifyContent: "space-between" }}><span className="muted">서버 연결</span><span className="num" style={{ color: serverOk === false ? "var(--danger)" : serverOk ? "#33e08a" : "var(--text-dim)" }}>{serverOk === false ? "끊김" : serverOk ? "OK" : "—"}</span></div>
            <div className="row" style={{ justifyContent: "space-between" }}><span className="muted">마지막 업데이트</span><span className="num">{lastUpdate || "—"}</span></div>
            {live && <div className="row" style={{ justifyContent: "space-between" }}><span className="muted">라이브</span><span className="num" style={{ color: "#33e08a" }}>● 폴링 중</span></div>}
        </FloatingPanel>
      )}

      {camRecording && (
        <div className="panel" style={{ top: 62, left: "50%", transform: "translateX(-50%)", zIndex: 6 }}>
          <div className="panel-section" style={{ flexDirection: "row", alignItems: "center", padding: "8px 14px", gap: 10 }}>
            <span className="rec-dot" /><span style={{ fontWeight: 700 }}>경로 녹화중</span>
            <button className="danger" onClick={toggleCamRecord}>■ 정지</button>
          </div>
        </div>
      )}

      {videoRec && (
        <div className="panel" style={{ top: 62, left: "50%", transform: "translateX(-50%)", zIndex: 6 }}>
          <div className="panel-section" style={{ flexDirection: "row", alignItems: "center", padding: "8px 14px", gap: 10 }}>
            <span className="rec-dot" /><span style={{ fontWeight: 700 }}>영상 녹화중</span>
            <button className="danger" onClick={stopVideoRecording}>■ 정지 &amp; 저장</button>
          </div>
        </div>
      )}

      {settings.wipeOn === 1 && (
        <div
          style={{ position: "absolute", top: 0, bottom: 0, left: `calc(${settings.wipePos * 100}% - 10px)`, width: 20, zIndex: 5, cursor: "ew-resize", touchAction: "none" }}
          onPointerDown={(e) => {
            e.preventDefault();
            (e.target as HTMLElement).setPointerCapture(e.pointerId);
            const onMove = (ev: PointerEvent) => {
              const p = Math.min(0.98, Math.max(0.02, ev.clientX / window.innerWidth));
              setSettings((s) => ({ ...s, wipePos: p }));
            };
            const onUp = () => {
              window.removeEventListener("pointermove", onMove);
              window.removeEventListener("pointerup", onUp);
            };
            window.addEventListener("pointermove", onMove);
            window.addEventListener("pointerup", onUp);
          }}
        >
          <div style={{ position: "absolute", left: 9, top: 0, bottom: 0, width: 2, background: "var(--accent)" }} />
          <div className="panel" style={{ position: "absolute", top: "50%", left: -22, transform: "translateY(-50%)", padding: "4px 8px", fontSize: 11, whiteSpace: "nowrap", pointerEvents: "none" }}>◂ A · B ▸</div>
        </div>
      )}

      {status && status !== "idle" && (
        <div className="num" style={{
          position: "absolute", left: "50%", transform: "translateX(-50%)",
          bottom: timelineVisible ? 118 : 14, zIndex: 7, pointerEvents: "none",
          background: "rgba(0, 0, 0, 0.55)", color: "#e8e8e8", padding: "5px 12px",
          borderRadius: 8, fontSize: 12, maxWidth: "min(72vw, 560px)",
          whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
          opacity: statusVisible ? 1 : 0, transition: "opacity 0.6s",
        }}>
          {status}
        </div>
      )}

      {dragOver && (
        <div style={{
          position: "absolute", inset: 10, zIndex: 9, pointerEvents: "none",
          border: "2px dashed var(--accent)", borderRadius: 10, background: "rgba(255,139,61,0.10)",
          display: "flex", alignItems: "center", justifyContent: "center",
          fontSize: 20, fontWeight: 700, color: "var(--accent)",
        }}>
          .ply / .splat 파일을 여기에 놓기
        </div>
      )}

      {emptyState && (
        <div style={{ position: "absolute", inset: 0, zIndex: 1, display: "flex", alignItems: "center", justifyContent: "center", pointerEvents: "none" }}>
          <div className="panel" style={{ position: "static", padding: "20px 26px", textAlign: "center", maxWidth: "min(420px, calc(100vw - 40px))" }}>
            <div style={{ fontSize: 34, marginBottom: 8 }}>{emptyState.err ? "⚠️" : "📦"}</div>
            <div className="panel-title" style={{ fontSize: 16, color: emptyState.err ? "var(--danger)" : "var(--text)" }}>{emptyState.title}</div>
            <div className="muted" style={{ marginTop: 6, fontSize: 13, lineHeight: 1.5 }}>{emptyState.sub}</div>
          </div>
        </div>
      )}

      {/* antialias off: MSAA does nothing for splats (alpha-blended quads) and
          costs fill-rate. preserveDrawingBuffer off: skips the per-frame
          backbuffer copy; CanvasCapture re-renders right before reading pixels
          instead, and captureStream (video export) grabs frames as they draw. */}
      <Canvas key={`${antialias ? "gl-aa" : "gl"}:${glEpoch}`} dpr={effDpr} gl={{ antialias, preserveDrawingBuffer: false, powerPreference: "high-performance" }} camera={{ position: [5, -5, 5], up: [0, 0, 1], near: 0.01, far: 1000 }}>
        <color attach="background" args={[bg]} />
        <OrbitControls makeDefault enableDamping={false} enableZoom={false} enableRotate={false} />
        <ContextLossGuard onLost={onGlLost} onRestored={onGlRestored} />
        <ConstantControlSpeed moveSens={moveSens} />
        <GestureControls sceneRadius={bounds ? radius(bounds) : 1} zoomSens={zoomSens} rotateSens={rotateSens} />
        <AutoOrbit enabled={autoOrbit && !camReplaying && !touring} speed={autoOrbitSpeed} />
        <CameraPath recording={camRecording} playing={touring || camReplaying} loop={touring} recRef={camRecRef} path={touring ? tourPoses : camPath} seekMs={camSeekMs} onProgress={touring ? () => {} : setCamSeekMs} onPlayEnd={() => { setCamReplaying(false); if (videoRecRef.current) videoRecRef.current.stop(); }} />
        {bounds && <ClipSweep enabled={clipSweep && settings.clipAxis >= 0} min={bounds.min[Math.max(0, settings.clipAxis)]} max={bounds.max[Math.max(0, settings.clipAxis)]} setPos={(v) => setSettings((s) => ({ ...s, clipPos: v }))} />}
        <KeyboardFly sceneRadius={bounds ? radius(bounds) : 1} moveSens={moveSens} />
        <CanvasCapture captureRef={captureRef} captureBlobRef={captureBlobRef} canvasRef={canvasRef} download={downloadBlob} />
        <FpsMeter elRef={fpsElRef} />
        <AdaptiveDpr enabled={dprAuto} value={autoDprValue} setValue={setAutoDprValue} max={nativeDpr} minFps={minFps} />
        <CameraBridge apiRef={camApiRef} />
        <InputController bufferRef={bufferRef} selectionRef={selectionRef} setSelection={setSelection} measureMode={measureMode}
          polyMode={polyMode} onPolyPick={(p) => setPolyPts((prev) => [...prev, p])}
          noteMode={noteMode} onNotePick={addNoteAt}
          onMeasurePick={onMeasurePick}
          onSetPivot={(p) => { camApiRef.current?.setTarget(p); setStatus(`회전축 설정: (${p.map((v) => v.toFixed(2)).join(", ")})`); }} />
        {showAxes && bounds && <axesHelper args={[radius(bounds)]} />}
        {buffer && bounds && selection.size > 0 && !measureMode && (
          <>
            <DragMoveHandle buffer={buffer} selection={selection} onStart={beginEdit} onMove={liveMove} onEnd={endEdit} />
            <RotateHandle buffer={buffer} selection={selection} onStart={beginEdit} onMove={liveRotate} onEnd={endEdit} />
          </>
        )}
        {measurePts.length > 0 && <MeasureView points={measurePts} />}
        {polyMode && polyPts.length > 0 && <PolyhedronPreview points={polyPts} />}
        {notes.length > 0 && <NotesView notes={notes} />}
        <RenderSettingsContext.Provider value={settingsDerived}>
          {showGrid && bounds && <DashedGrid bounds={bounds} opts={grid} />}
          {display && bounds && (
            <>
              <FitCamera bounds={bounds} enabled={!camDone && !pendingView.current} onFitted={() => setCamDone(true)} />
              {pendingView.current && <ApplyCamera view={pendingView.current} onApplied={() => setCamDone(true)} />}
              <SplatRenderContext key={splatKey}>
                {showMap && <SplatObject buffer={lod ?? display} sh1={lodSh ?? undefined} />}
                {compares.map((c) => c.visible && <SplatObject key={c.id} buffer={c.buffer} />)}
              </SplatRenderContext>
            </>
          )}
        </RenderSettingsContext.Provider>
      </Canvas>
      {glLost && (
        <div style={{
          position: "fixed", inset: 0, display: "flex", alignItems: "center", justifyContent: "center",
          background: "rgba(0,0,0,0.6)", color: "#eee", fontFamily: "system-ui, sans-serif", pointerEvents: "none",
        }}>
          <div style={{ padding: "12px 18px", borderRadius: 10, background: "rgba(20,20,20,0.9)", fontSize: 14 }}>
            렌더러 복구 중…
          </div>
        </div>
      )}
    </div>
  );
}
