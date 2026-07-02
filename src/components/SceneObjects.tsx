import React from "react";
import * as THREE from "three";
import { useThree, useFrame } from "@react-three/fiber";
import { type Bounds, center, radius, selCenter } from "../lib/bounds";

export interface GridOpts { color: string; divisions: number; dashSize: number; gapSize: number; }
export interface DragRect { x0: number; y0: number; x1: number; y1: number }

const DEG = Math.PI / 180;

/** World-space size that projects to a constant `px` on screen at `worldPos`
 * (so gizmos look the same size regardless of camera distance). */
function screenWorldScale(camera: THREE.Camera, worldPos: THREE.Vector3, viewportH: number, px: number): number {
  const cam = camera as THREE.PerspectiveCamera;
  const d = cam.position.distanceTo(worldPos);
  return (d * 2 * Math.tan((cam.fov * DEG) / 2) / viewportH) * px;
}

/** A unit sphere kept at a constant on-screen radius (`px`). */
function ScreenSphere({ position, px, color }: { position: [number, number, number]; px: number; color: string }) {
  const ref = React.useRef<THREE.Mesh>(null);
  useFrame((state) => {
    const m = ref.current;
    if (m) m.scale.setScalar(screenWorldScale(state.camera, m.position, state.size.height, px));
  });
  return (
    <mesh ref={ref} position={position} renderOrder={20000}>
      <sphereGeometry args={[1, 16, 16]} />
      <meshBasicMaterial color={color} depthTest={false} transparent opacity={0.9} />
    </mesh>
  );
}

type Controls = { target: { set: (x: number, y: number, z: number) => void }; update: () => void } | null;

/** Initial camera on load: start AT the world origin (usually the capture /
 * reference origin) looking at the data centre, z-up. Runs only on the first
 * enabled fit; near/far track bounds every load so reloads don't re-aim the
 * camera (keeps your current view) but also don't clip. */
export function FitCamera({ bounds, enabled = true, onFitted }: { bounds: Bounds; enabled?: boolean; onFitted?: () => void }) {
  const camera = useThree((s) => s.camera);
  const controls = useThree((s) => s.controls) as Controls;
  const fitted = React.useRef(false);
  React.useEffect(() => {
    const r = radius(bounds);
    camera.near = Math.max(r * 0.001, 0.001);
    camera.far = r * 5000 + 1000;
    camera.updateProjectionMatrix();
    if (!enabled || fitted.current) return;
    fitted.current = true;
    const c = center(bounds);
    camera.up.set(0, 0, 1);
    camera.position.set(0, 0, 0);
    // Face AWAY from the data centre (the capture's forward direction is
    // typically opposite the reconstructed content); fall back to +y when the
    // centre coincides with the origin.
    const t = Math.hypot(c[0], c[1], c[2]) > r * 1e-3 ? [-c[0], -c[1], -c[2]] : [0, 1, 0];
    if (controls?.target) { controls.target.set(t[0], t[1], t[2]); controls.update(); }
    else camera.lookAt(t[0], t[1], t[2]);
    onFitted?.();
  }, [bounds, camera, controls, enabled, onFitted]);
  return null;
}

/** Applies a saved camera (pos + target) once, for URL-restored views. */
export function ApplyCamera({ view, onApplied }: { view: { p: [number, number, number]; t: [number, number, number] }; onApplied?: () => void }) {
  const camera = useThree((s) => s.camera);
  const controls = useThree((s) => s.controls) as Controls;
  const done = React.useRef(false);
  React.useEffect(() => {
    if (done.current) return;
    done.current = true;
    camera.up.set(0, 0, 1);
    camera.position.set(view.p[0], view.p[1], view.p[2]);
    if (controls?.target) { controls.target.set(view.t[0], view.t[1], view.t[2]); controls.update(); }
    else camera.lookAt(view.t[0], view.t[1], view.t[2]);
    onApplied?.();
  }, [camera, controls, view, onApplied]);
  return null;
}

export interface CameraApi {
  get: () => { p: [number, number, number]; t: [number, number, number] };
  apply: (p: [number, number, number], t: [number, number, number]) => void;
  /** Move only the orbit target (rotation pivot); the camera stays put. */
  setTarget: (t: [number, number, number]) => void;
}

/** Publishes get/apply for the camera pos+target (share URLs + view presets). */
export function CameraBridge({ apiRef }: { apiRef: React.MutableRefObject<CameraApi | null> }) {
  const camera = useThree((s) => s.camera);
  const controls = useThree((s) => s.controls) as { target: THREE.Vector3; update: () => void } | null;
  React.useEffect(() => {
    apiRef.current = {
      get: () => ({
        p: [camera.position.x, camera.position.y, camera.position.z],
        t: controls?.target ? [controls.target.x, controls.target.y, controls.target.z] : [0, 0, 0],
      }),
      apply: (p, t) => {
        camera.up.set(0, 0, 1);
        camera.position.set(p[0], p[1], p[2]);
        if (controls?.target) { controls.target.set(t[0], t[1], t[2]); controls.update(); }
        else camera.lookAt(t[0], t[1], t[2]);
      },
      setTarget: (t) => {
        if (controls?.target) { controls.target.set(t[0], t[1], t[2]); controls.update(); }
      },
    };
    return () => { apiRef.current = null; };
  }, [camera, controls, apiRef]);
  return null;
}

/** Polyline measure: a sphere at each picked point + connecting segments. */
export function MeasureView({ points }: { points: [number, number, number][] }) {
  const lineGeo = React.useMemo(() => {
    if (points.length < 2) return null;
    const pts: number[] = [];
    for (let i = 1; i < points.length; i++) pts.push(...points[i - 1], ...points[i]);
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
    return g;
  }, [points]);
  return (
    <>
      {points.map((p, i) => <ScreenSphere key={i} position={p} px={7} color="#00d0ff" />)}
      {lineGeo && (
        <lineSegments frustumCulled={false} renderOrder={20000} geometry={lineGeo}>
          <lineBasicMaterial color="#00d0ff" depthTest={false} />
        </lineSegments>
      )}
    </>
  );
}

/** Dashed grid on the z=min floor plane. */
export function DashedGrid({ bounds, opts }: { bounds: Bounds; opts: GridOpts }) {
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

/** Double-click = point pick (front-most gaussian; Shift adds). Plain drag =
 * camera. Long-press (hold still ~0.5s) = set the rotation pivot (orbit
 * target) to the gaussian under the pointer. In measure mode a double-click
 * instead reports the picked gaussian's world position (distance tool). */
export function InputController({
  bufferRef, selectionRef, setSelection, measureMode, onMeasurePick, onSetPivot,
}: {
  bufferRef: React.MutableRefObject<Uint32Array | null>;
  selectionRef: React.MutableRefObject<Set<number>>;
  setSelection: (s: Set<number>) => void;
  measureMode: boolean;
  onMeasurePick: (p: [number, number, number]) => void;
  onSetPivot?: (p: [number, number, number]) => void;
}) {
  const gl = useThree((s) => s.gl);
  const camera = useThree((s) => s.camera);
  const size = useThree((s) => s.size);
  const controls = useThree((s) => s.controls) as { enabled: boolean } | null;
  const env = React.useRef({ camera, w: size.width, h: size.height, measureMode, onMeasurePick, onSetPivot });
  env.current = { camera, w: size.width, h: size.height, measureMode, onMeasurePick, onSetPivot };

  React.useEffect(() => {
    const el = gl.domElement;
    let lastUp = 0, lx = 0, ly = 0, sel = false, sx = 0, sy = 0;

    // Front-most gaussian near a screen point, or -1. Among everything within
    // the pick radius, prefer the one closest to the CAMERA (not the cursor),
    // so clicking a surface never grabs something hidden behind it.
    function pickNearest(x0: number, y0: number): number {
      const buffer = bufferRef.current;
      if (!buffer) return -1;
      const { camera, w, h } = env.current;
      const dv = new DataView(buffer.buffer);
      const n = buffer.length / 8;
      const v = new THREE.Vector3();
      let best = -1, bestCam = Infinity;
      for (let i = 0; i < n; i++) {
        const b = i * 32; if (dv.getUint8(b + 31) === 0) continue;
        v.set(dv.getFloat32(b, true), dv.getFloat32(b + 4, true), dv.getFloat32(b + 8, true));
        const camD = v.distanceTo(camera.position);
        v.project(camera);
        if (v.z < -1 || v.z > 1) continue;
        const px = (v.x * 0.5 + 0.5) * w, py = (-v.y * 0.5 + 0.5) * h;
        if ((px - x0) ** 2 + (py - y0) ** 2 > 400) continue;
        if (camD < bestCam) { bestCam = camD; best = i; }
      }
      return best;
    }

    // Point pick: front-most gaussian under the cursor; Shift adds to the
    // current selection. (Box/drag select was removed — piercing the whole
    // scene made precise selection impossible.)
    function pick(x0: number, y0: number, additive: boolean) {
      const buffer = bufferRef.current;
      if (!buffer) return;
      const out = additive ? new Set(selectionRef.current) : new Set<number>();
      const best = pickNearest(x0, y0);
      if (best >= 0) out.add(best);
      setSelection(out);
    }

    function measure(x0: number, y0: number) {
      const buffer = bufferRef.current;
      const idx = pickNearest(x0, y0);
      if (idx < 0 || !buffer) return;
      const dv = new DataView(buffer.buffer);
      const b = idx * 32;
      env.current.onMeasurePick([dv.getFloat32(b, true), dv.getFloat32(b + 4, true), dv.getFloat32(b + 8, true)]);
    }

    // Long-press pivot: armed on a single still pointer, cancelled by movement
    // (>8px), a second pointer (pinch), release, or a double-click select.
    let lpTimer: number | null = null, lpX = 0, lpY = 0, pointersDown = 0;
    const cancelLp = () => { if (lpTimer !== null) { clearTimeout(lpTimer); lpTimer = null; } };

    const down = (e: PointerEvent) => {
      pointersDown++;
      cancelLp();
      const now = performance.now();
      if (now - lastUp < 300 && Math.hypot(e.clientX - lx, e.clientY - ly) < 12) {
        // double-click: point pick on release; lock the camera meanwhile
        sel = true; sx = e.clientX; sy = e.clientY;
        if (controls) controls.enabled = false;
      } else if (pointersDown === 1 && env.current.onSetPivot) {
        lpX = e.clientX; lpY = e.clientY;
        lpTimer = window.setTimeout(() => {
          lpTimer = null;
          const buffer = bufferRef.current;
          const idx = pickNearest(lpX, lpY);
          if (idx < 0 || !buffer) return;
          const dv = new DataView(buffer.buffer);
          const b = idx * 32;
          env.current.onSetPivot?.([dv.getFloat32(b, true), dv.getFloat32(b + 4, true), dv.getFloat32(b + 8, true)]);
        }, 550);
      }
    };
    const move = (e: PointerEvent) => {
      if (lpTimer !== null && Math.hypot(e.clientX - lpX, e.clientY - lpY) > 8) cancelLp();
    };
    const up = (e: PointerEvent) => {
      pointersDown = Math.max(0, pointersDown - 1);
      cancelLp();
      if (sel) {
        const dist = Math.hypot(e.clientX - sx, e.clientY - sy);
        if (dist < 5) {
          if (env.current.measureMode) measure(sx, sy);
          else pick(sx, sy, e.shiftKey);
        }
        sel = false; if (controls) controls.enabled = true;
      }
      lastUp = performance.now(); lx = e.clientX; ly = e.clientY;
    };
    // NOTE: bubble phase (not capture) so the gizmo/orbit get pointerdown first.
    el.addEventListener("pointerdown", down);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      cancelLp();
      el.removeEventListener("pointerdown", down);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [gl, controls, bufferRef, selectionRef, setSelection]);
  return null;
}

/** Exposes a canvas->PNG capture fn via captureRef and the canvas element via
 * canvasRef (for video recording). Needs `gl`, so lives inside Canvas. The
 * Canvas runs without preserveDrawingBuffer (perf), so the backbuffer may be
 * cleared by compositing; re-render synchronously right before toBlob so the
 * pixels are guaranteed fresh. */
export function CanvasCapture({
  captureRef, captureBlobRef, canvasRef, download,
}: {
  captureRef: React.MutableRefObject<((name: string) => void) | null>;
  captureBlobRef?: React.MutableRefObject<(() => Promise<Blob | null>) | null>;
  canvasRef?: React.MutableRefObject<HTMLCanvasElement | null>;
  download: (blob: Blob, name: string) => void;
}) {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const camera = useThree((s) => s.camera);
  React.useEffect(() => {
    captureRef.current = (name) => {
      gl.render(scene, camera);
      gl.domElement.toBlob((b) => { if (b) download(b, name); }, "image/png");
    };
    if (captureBlobRef) {
      captureBlobRef.current = () =>
        new Promise<Blob | null>((resolve) => {
          gl.render(scene, camera);
          gl.domElement.toBlob((b) => resolve(b), "image/png");
        });
    }
    if (canvasRef) canvasRef.current = gl.domElement;
    return () => {
      captureRef.current = null;
      if (captureBlobRef) captureBlobRef.current = null;
      if (canvasRef) canvasRef.current = null;
    };
  }, [gl, scene, camera, download, canvasRef, captureBlobRef]);
  return null;
}

/** Quality-first adaptive resolution: render at native DPR and step down only
 * when measured fps can't keep up. Down fast (any bad 1s window), up slow
 * (3 consecutive good windows + cooldown) so it doesn't oscillate. */
export function AdaptiveDpr({ enabled, value, setValue, max, minFps = 15 }: {
  enabled: boolean; value: number; setValue: (v: number) => void; max: number; minFps?: number;
}) {
  const acc = React.useRef({ frames: 0, t0: 0, lastChange: 0, goodWindows: 0 });
  useFrame(() => {
    if (!enabled) return;
    const a = acc.current;
    const now = performance.now();
    if (a.t0 === 0) { a.t0 = now; return; }
    a.frames++;
    const dt = now - a.t0;
    if (dt < 1000) return;
    const fps = (a.frames * 1000) / dt;
    a.t0 = now; a.frames = 0;
    if (dt > 2000 || document.hidden) return; // rAF was throttled (background tab)
    const cooldown = now - a.lastChange < 3000;
    // Max quality by default: resolution is shed ONLY below the user's minFps
    // floor, and climbs back toward native whenever fps holds minFps+10 —
    // so anything at/above the floor renders at the highest sustainable DPR.
    if (fps < minFps && value > 0.75 && !cooldown) {
      a.lastChange = now; a.goodWindows = 0;
      setValue(Math.max(0.75, Math.round((value - 0.25) * 4) / 4));
    } else if (fps > minFps + 10 && value < max) {
      a.goodWindows++;
      if (a.goodWindows >= 2 && !cooldown) {
        a.lastChange = now; a.goodWindows = 0;
        setValue(Math.min(max, value + 0.25));
      }
    } else {
      a.goodWindows = 0;
    }
  });
  return null;
}

/** Live fps / frame-time readout. Counts real rendered frames via useFrame and
 * writes into `elRef` twice a second — no React state, so the meter itself adds
 * zero per-frame overhead. */
export function FpsMeter({ elRef }: { elRef: React.MutableRefObject<HTMLElement | null> }) {
  const acc = React.useRef({ frames: 0, t0: 0 });
  useFrame(() => {
    const a = acc.current;
    const now = performance.now();
    if (a.t0 === 0) { a.t0 = now; return; }
    a.frames++;
    const dt = now - a.t0;
    if (dt >= 500) {
      if (elRef.current) elRef.current.textContent = `${((a.frames * 1000) / dt).toFixed(0)} fps · ${(dt / a.frames).toFixed(1)} ms`;
      a.t0 = now; a.frames = 0;
    }
  });
  return null;
}

export type CamPose = { p: [number, number, number]; t: [number, number, number]; ms: number };

// Catmull-Rom: smooth curve through p1,p2 using neighbours p0,p3 as tangents.
function catmull(p0: number, p1: number, p2: number, p3: number, u: number) {
  const u2 = u * u, u3 = u2 * u;
  return 0.5 * (2 * p1 + (-p0 + p2) * u + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u2 + (-p0 + 3 * p1 - 3 * p2 + p3) * u3);
}

/** Interpolated camera pose at time `ms` along a path, using a Catmull-Rom
 * spline so it curves smoothly through the keyframes instead of cornering. */
export function poseAt(path: CamPose[], ms: number): CamPose | null {
  if (path.length === 0) return null;
  if (ms <= path[0].ms) return path[0];
  const last = path[path.length - 1];
  if (ms >= last.ms) return last;
  let i = 1;
  while (i < path.length && path[i].ms < ms) i++;
  const n = path.length;
  const at = (k: number) => path[Math.max(0, Math.min(n - 1, k))]; // clamp neighbours at ends
  const p0 = at(i - 2), a = path[i - 1], b = path[i], p3 = at(i + 1);
  const u = (ms - a.ms) / ((b.ms - a.ms) || 1);
  const cp = (k: number) => catmull(p0.p[k], a.p[k], b.p[k], p3.p[k], u);
  const ct = (k: number) => catmull(p0.t[k], a.t[k], b.t[k], p3.t[k], u);
  return { p: [cp(0), cp(1), cp(2)], t: [ct(0), ct(1), ct(2)], ms };
}

/** Record the camera pose (pos + orbit target) over time into recRef while
 * `recording`; replay it while `playing` (reporting progress via onProgress);
 * or jump to `seekMs` (timeline scrub) when not playing. Framerate-independent. */
export function CameraPath({ recording, playing, loop, recRef, path, seekMs, onProgress, onPlayEnd }: {
  recording: boolean;
  playing: boolean;
  loop?: boolean;
  recRef: React.MutableRefObject<CamPose[]>;
  path: CamPose[];
  seekMs: number | null;
  onProgress: (ms: number) => void;
  onPlayEnd: () => void;
}) {
  const camera = useThree((s) => s.camera);
  const controls = useThree((s) => s.controls) as { target: THREE.Vector3; update: () => void } | null;
  const recT = React.useRef(0), lastSample = React.useRef(-1), prevRec = React.useRef(false);
  const playT = React.useRef(0), prevPlay = React.useRef(false), lastReport = React.useRef(0);

  const apply = (pose: CamPose | null) => {
    if (!pose || !controls) return;
    camera.position.set(pose.p[0], pose.p[1], pose.p[2]);
    controls.target.set(pose.t[0], pose.t[1], pose.t[2]);
    controls.update();
  };

  // Scrub: apply the seek pose only when the user actually moves it. Keyed on
  // seekMs alone (not `playing`) so stopping a tour/playback doesn't snap the
  // camera back to a stale scrub position.
  React.useEffect(() => {
    if (!playing && seekMs != null) apply(poseAt(path, seekMs));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seekMs]);

  useFrame((_, delta) => {
    const dt = Math.min(delta, 0.1);
    if (recording) {
      if (!prevRec.current) { recRef.current = []; recT.current = 0; lastSample.current = -1; }
      recT.current += dt;
      if (recT.current - lastSample.current >= 0.05) { // ~20 samples/s
        lastSample.current = recT.current;
        const t = controls?.target;
        recRef.current.push({
          p: [camera.position.x, camera.position.y, camera.position.z],
          t: t ? [t.x, t.y, t.z] : [0, 0, 0],
          ms: recT.current,
        });
      }
    }
    prevRec.current = recording;

    if (playing && path.length >= 2) {
      if (!prevPlay.current) { playT.current = seekMs ?? 0; lastReport.current = -1; }
      playT.current += dt;
      const end = path[path.length - 1].ms;
      if (playT.current >= end) {
        if (loop) { playT.current = playT.current % end || 0; apply(poseAt(path, playT.current)); }
        else { onProgress(end); onPlayEnd(); }
      } else {
        apply(poseAt(path, playT.current));
        if (playT.current - lastReport.current > 0.07) { lastReport.current = playT.current; onProgress(playT.current); }
      }
    }
    prevPlay.current = playing;
  });
  return null;
}

/** Auto-orbit: slowly revolve the camera around the target about world-up (z),
 * like a turntable, for hands-free review / recording. */
export function AutoOrbit({ enabled, speed }: { enabled: boolean; speed: number }) {
  const camera = useThree((s) => s.camera);
  const controls = useThree((s) => s.controls) as { target: THREE.Vector3; update: () => void } | null;
  useFrame((_, delta) => {
    if (!enabled || !controls) return;
    const t = controls.target;
    const dx = camera.position.x - t.x, dy = camera.position.y - t.y;
    const a = speed * Math.min(delta, 0.05);
    const c = Math.cos(a), s = Math.sin(a);
    camera.position.x = t.x + dx * c - dy * s;
    camera.position.y = t.y + dx * s + dy * c;
    controls.update();
  });
  return null;
}

/** Sweep the clipping plane back and forth across [min,max] to reveal the
 * interior. Throttled to ~30/s so the per-frame setState doesn't churn React. */
export function ClipSweep({ enabled, min, max, setPos }: {
  enabled: boolean; min: number; max: number; setPos: (v: number) => void;
}) {
  const t = React.useRef(0), acc = React.useRef(0);
  useFrame((_, delta) => {
    if (!enabled) return;
    const dt = Math.min(delta, 0.1);
    t.current += dt; acc.current += dt;
    if (acc.current < 0.03) return;
    acc.current = 0;
    const u = (1 - Math.cos((t.current / 4) * Math.PI * 2)) / 2; // 0→1→0 ease, 4s round trip
    setPos(min + (max - min) * u);
  });
  return null;
}

/** Drag handle (sphere) at the selection centroid. Drag = move along the camera
 * plane. Built directly (raycast -> plane) because TransformControls' translate
 * is broken in this stack. onMove fires the running net delta live during the
 * drag; onStart/onEnd bracket it (snapshot for undo / finalize). */
export function DragMoveHandle({
  buffer, selection, onStart, onMove, onEnd,
}: {
  buffer: Uint32Array | null; selection: Set<number>;
  onStart: () => void; onMove: (dx: number, dy: number, dz: number) => void; onEnd: () => void;
}) {
  const camera = useThree((s) => s.camera);
  const gl = useThree((s) => s.gl);
  const controls = useThree((s) => s.controls) as { enabled: boolean } | null;
  const meshRef = React.useRef<THREE.Mesh>(null);

  const pos = React.useMemo<[number, number, number]>(
    () => (buffer && selection.size > 0 ? selCenter(buffer, selection) : [0, 0, 0]),
    [buffer, selection],
  );
  React.useEffect(() => {
    if (meshRef.current) meshRef.current.position.set(pos[0], pos[1], pos[2]);
  }, [pos]);
  useFrame((state) => {
    const m = meshRef.current;
    if (m) m.scale.setScalar(screenWorldScale(state.camera, m.position, state.size.height, 8));
  });

  if (!buffer || selection.size === 0) return null;

  function startDrag(e: { stopPropagation: () => void }) {
    e.stopPropagation();
    if (controls) controls.enabled = false;
    onStart();
    const plane = new THREE.Plane();
    const n = new THREE.Vector3();
    camera.getWorldDirection(n);
    plane.setFromNormalAndCoplanarPoint(n, meshRef.current!.position.clone());
    const rect = gl.domElement.getBoundingClientRect();
    const ray = new THREE.Raycaster();
    const hit = new THREE.Vector3();
    const last = new THREE.Vector3();
    const total = new THREE.Vector3();
    let started = false;
    const castTo = (ev: PointerEvent, out: THREE.Vector3) => {
      const ndc = new THREE.Vector2(
        ((ev.clientX - rect.left) / rect.width) * 2 - 1,
        -((ev.clientY - rect.top) / rect.height) * 2 + 1,
      );
      ray.setFromCamera(ndc, camera);
      return ray.ray.intersectPlane(plane, out) !== null;
    };
    const onPM = (ev: PointerEvent) => {
      if (!meshRef.current) return;
      if (!started) { if (castTo(ev, last)) started = true; return; }
      if (!castTo(ev, hit)) return;
      const dx = hit.x - last.x, dy = hit.y - last.y, dz = hit.z - last.z;
      meshRef.current.position.x += dx;
      meshRef.current.position.y += dy;
      meshRef.current.position.z += dz;
      total.x += dx; total.y += dy; total.z += dz;
      onMove(total.x, total.y, total.z); // live, net from drag start
      last.copy(hit);
    };
    const onPU = () => {
      if (controls) controls.enabled = true;
      onEnd();
      window.removeEventListener("pointermove", onPM);
      window.removeEventListener("pointerup", onPU);
    };
    window.addEventListener("pointermove", onPM);
    window.addEventListener("pointerup", onPU);
  }

  return (
    <mesh ref={meshRef} position={pos} onPointerDown={startDrag} renderOrder={20000}>
      <sphereGeometry args={[1, 16, 16]} />
      <meshBasicMaterial color="#ff8800" depthTest={false} transparent opacity={0.85} />
    </mesh>
  );
}

/** Rotate ring at the selection centroid. Always billboards to face the camera,
 * so dragging it around the centre spins the selection about the view axis (like
 * a gizmo's screen-space ring). onMove fires the net rotation (row-major 3x3)
 * live during the drag; onStart/onEnd bracket it. */
export function RotateHandle({
  buffer, selection, onStart, onMove, onEnd,
}: {
  buffer: Uint32Array | null; selection: Set<number>;
  onStart: () => void; onMove: (rowMajor3x3: number[]) => void; onEnd: () => void;
}) {
  const camera = useThree((s) => s.camera);
  const gl = useThree((s) => s.gl);
  const controls = useThree((s) => s.controls) as { enabled: boolean } | null;
  const groupRef = React.useRef<THREE.Group>(null);
  const spinRef = React.useRef(0); // live drag angle (ring visual)

  const pos = React.useMemo<[number, number, number]>(
    () => (buffer && selection.size > 0 ? selCenter(buffer, selection) : [0, 0, 0]),
    [buffer, selection],
  );

  // Billboard to face the camera, keep a constant on-screen size, then apply the
  // live spin around the view axis.
  useFrame((state) => {
    const g = groupRef.current;
    if (!g) return;
    g.position.set(pos[0], pos[1], pos[2]);
    g.quaternion.copy(camera.quaternion);
    g.rotateZ(spinRef.current);
    g.scale.setScalar(screenWorldScale(state.camera, g.position, state.size.height, 54));
  });

  if (!buffer || selection.size === 0) return null;

  function startDrag(e: { stopPropagation: () => void }) {
    e.stopPropagation();
    if (controls) controls.enabled = false;
    onStart();
    const c = new THREE.Vector3(pos[0], pos[1], pos[2]);
    const cN = c.clone().project(camera); // centroid in NDC
    const axis = camera.position.clone().sub(c).normalize(); // toward camera
    const rect = gl.domElement.getBoundingClientRect();
    const m = new THREE.Matrix4();
    const angleAt = (ev: PointerEvent) => {
      const mx = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
      const my = -(((ev.clientY - rect.top) / rect.height) * 2 - 1); // NDC y-up
      return Math.atan2(my - cN.y, mx - cN.x);
    };
    let start: number | null = null;
    const onPM = (ev: PointerEvent) => {
      const a = angleAt(ev);
      if (start === null) { start = a; return; }
      const delta = a - start;
      spinRef.current = delta;
      const e2 = m.makeRotationAxis(axis, delta).elements; // column-major
      onMove([e2[0], e2[4], e2[8], e2[1], e2[5], e2[9], e2[2], e2[6], e2[10]]); // live, net
    };
    const onPU = () => {
      if (controls) controls.enabled = true;
      spinRef.current = 0;
      onEnd();
      window.removeEventListener("pointermove", onPM);
      window.removeEventListener("pointerup", onPU);
    };
    window.addEventListener("pointermove", onPM);
    window.addEventListener("pointerup", onPU);
  }

  return (
    <group ref={groupRef} position={pos}>
      <mesh onPointerDown={startDrag} renderOrder={20000}>
        <torusGeometry args={[1, 0.18, 16, 64]} />
        <meshBasicMaterial color="#33e08a" depthTest={false} transparent opacity={0.85} />
      </mesh>
    </group>
  );
}

/** Keeps OrbitControls' remaining role (pan) on the knob system: 이동 감도
 * drives two-finger / right-drag PAN speed (translation, shared with WASD).
 * Rotation and zoom are fully custom in GestureControls (OrbitControls
 * rotate + dolly are disabled). */
const IS_COARSE_POINTER =
  typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches;
const TOUCH_ROTATE_FACTOR = 0.05;

export function ConstantControlSpeed({ moveSens = 1 }: { moveSens?: number }) {
  const controls = useThree((s) => s.controls) as { panSpeed: number } | null;
  useFrame(() => {
    if (!controls) return;
    controls.panSpeed = moveSens * (IS_COARSE_POINTER ? 0.6 : 1);
  });
  return null;
}

/** Custom camera gestures — all relative to the CURRENT view, not world axes:
 * - Drag (mouse-left / one finger) = screen-space orbit (trackball): horizontal
 *   drags rotate about the screen's vertical axis, vertical drags about the
 *   screen's horizontal axis, through the orbit target. The scene follows the
 *   pointer regardless of which way you're looking.
 * - Wheel / two-finger pinch = fly FORWARD/BACK along the view direction —
 *   camera and orbit target translate together (exactly like WASD), so zoom
 *   never stalls at the orbit target and can pass through the scene.
 * - Two-finger twist = ROLL around the screen axis (photo-style).
 * OrbitControls' own rotate + dolly are disabled; its pan still composes.
 * Preset-view / origin jumps re-set camera.up, which levels the horizon. */
export function GestureControls({ sceneRadius, zoomSens = 1, rotateSens = 1 }: { sceneRadius: number; zoomSens?: number; rotateSens?: number }) {
  const gl = useThree((s) => s.gl);
  const camera = useThree((s) => s.camera);
  const controls = useThree((s) => s.controls) as { target: THREE.Vector3; enabled: boolean; update: () => void } | null;
  const ref = React.useRef({ camera, controls, sceneRadius, zoomSens, rotateSens });
  ref.current = { camera, controls, sceneRadius, zoomSens, rotateSens };

  React.useEffect(() => {
    const el = gl.domElement;
    const fwd = new THREE.Vector3();
    const off = new THREE.Vector3();
    const upAxis = new THREE.Vector3();
    const rightAxis = new THREE.Vector3();
    const q1 = new THREE.Quaternion();
    const q2 = new THREE.Quaternion();

    // Translate camera + target along the view direction by `move` world units.
    const flyForward = (move: number) => {
      const { camera: cam, controls: ctl } = ref.current;
      if (!ctl || move === 0) return;
      cam.getWorldDirection(fwd).multiplyScalar(move);
      cam.position.add(fwd);
      ctl.target.add(fwd);
      ctl.update();
    };

    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const { sceneRadius: r, zoomSens: zs } = ref.current;
      const dy = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY; // lines -> px-ish
      flyForward(-dy * 0.0008 * (r || 1) * zs); // ~8% of scene radius per notch
    };

    const touches = new Map<number, { x: number; y: number }>();
    let prevAngle: number | null = null;
    let prevDist: number | null = null;
    const angleOf = () => {
      const [a, b] = [...touches.values()];
      return Math.atan2(b.y - a.y, b.x - a.x);
    };
    const distOf = () => {
      const [a, b] = [...touches.values()];
      return Math.hypot(b.x - a.x, b.y - a.y);
    };
    const resetPair = () => {
      const two = touches.size === 2;
      prevAngle = two ? angleOf() : null;
      prevDist = two ? distOf() : null;
    };
    // Screen-space orbit (trackball) drag state.
    let rotId: number | null = null;
    let rotX = 0, rotY = 0;

    const trackballRotate = (dx: number, dy: number, isTouch: boolean) => {
      const { camera: cam, controls: ctl, rotateSens: rs } = ref.current;
      if (!ctl || ctl.enabled === false || (dx === 0 && dy === 0)) return;
      const k = ((2 * Math.PI) / el.clientHeight) * rs * (isTouch ? TOUCH_ROTATE_FACTOR : 1);
      off.copy(cam.position).sub(ctl.target);
      upAxis.copy(cam.up).normalize();
      fwd.copy(ctl.target).sub(cam.position).normalize();
      rightAxis.crossVectors(fwd, upAxis).normalize();
      // Negative angles make the scene follow the pointer.
      q1.setFromAxisAngle(upAxis, -dx * k);
      q2.setFromAxisAngle(rightAxis, -dy * k);
      q1.multiply(q2);
      off.applyQuaternion(q1);
      cam.up.applyQuaternion(q1);
      cam.position.copy(ctl.target).add(off);
      ctl.update();
    };

    const down = (e: PointerEvent) => {
      if (e.pointerType === "touch") {
        touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
        resetPair();
        rotId = touches.size === 1 ? e.pointerId : null;
      } else if (e.button === 0) {
        rotId = e.pointerId;
      } else {
        return;
      }
      rotX = e.clientX; rotY = e.clientY;
    };
    const move = (e: PointerEvent) => {
      if (e.pointerType === "touch" && touches.has(e.pointerId)) {
        touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (touches.size === 2) {
          // Pinch = fly forward/back (spread fingers to move in).
          const dist = distOf();
          if (prevDist !== null) {
            const { sceneRadius: r, zoomSens: zs } = ref.current;
            flyForward((dist - prevDist) * 0.0025 * (r || 1) * zs);
          }
          prevDist = dist;
          // Twist = roll around the view (screen) axis. The camera sits on
          // that axis, so only the up vector needs rotating; negative sign
          // makes the scene follow the fingers (screen y grows downward).
          const a = angleOf();
          if (prevAngle !== null) {
            let d = a - prevAngle;
            if (d > Math.PI) d -= 2 * Math.PI;
            else if (d < -Math.PI) d += 2 * Math.PI;
            const { camera: cam, controls: ctl, rotateSens: rs } = ref.current;
            if (ctl && ctl.enabled !== false && d !== 0) {
              cam.getWorldDirection(fwd);
              cam.up.applyAxisAngle(fwd, -d * rs); // 회전 감도 scales the twist too
              ctl.update();
            }
          }
          prevAngle = a;
          return;
        }
      }
      if (e.pointerId === rotId) {
        const dx = e.clientX - rotX, dy = e.clientY - rotY;
        rotX = e.clientX; rotY = e.clientY;
        trackballRotate(dx, dy, e.pointerType === "touch");
      }
    };
    const up = (e: PointerEvent) => {
      if (e.pointerId === rotId) rotId = null;
      if (e.pointerType !== "touch") return;
      touches.delete(e.pointerId);
      resetPair();
      if (touches.size === 1) {
        // Back to one finger: resume rotating with the remaining pointer.
        const [id] = touches.keys();
        const p = touches.get(id)!;
        rotId = id; rotX = p.x; rotY = p.y;
      }
    };
    el.addEventListener("wheel", wheel, { passive: false });
    el.addEventListener("pointerdown", down);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => {
      el.removeEventListener("wheel", wheel);
      el.removeEventListener("pointerdown", down);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
  }, [gl]);
  return null;
}

/** WASD / arrow-key fly: translate camera + orbit target together so it reads as
 * moving through the scene. Constant speed everywhere (scaled only by scene
 * size, not by zoom/orbit distance); Shift = faster, Q/E (or Space) = down/up
 * along world-up (z). */
const FLY_KEYS = new Set(["w", "a", "s", "d", "q", "e", " ", "shift", "arrowup", "arrowdown", "arrowleft", "arrowright"]);

export function KeyboardFly({ sceneRadius = 1, moveSens = 1 }: { sceneRadius?: number; moveSens?: number }) {
  const camera = useThree((s) => s.camera);
  const controls = useThree((s) => s.controls) as { target: THREE.Vector3; update: () => void } | null;
  const keys = React.useRef<Set<string>>(new Set());

  React.useEffect(() => {
    const isField = (t: EventTarget | null) => {
      const el = t as HTMLElement | null;
      return !!el && (el.tagName === "INPUT" || el.tagName === "SELECT" || el.tagName === "TEXTAREA");
    };
    const down = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if (!FLY_KEYS.has(k) || isField(e.target)) return;
      keys.current.add(k);
      if (k.startsWith("arrow") || k === " ") e.preventDefault(); // these scroll the page
    };
    const up = (e: KeyboardEvent) => keys.current.delete(e.key.toLowerCase());
    const blur = () => keys.current.clear();
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
  }, []);

  const fwd = React.useMemo(() => new THREE.Vector3(), []);
  const right = React.useMemo(() => new THREE.Vector3(), []);
  const pan = React.useMemo(() => new THREE.Vector3(), []);
  const dirTC = React.useMemo(() => new THREE.Vector3(), []);
  const UP = React.useMemo(() => new THREE.Vector3(0, 0, 1), []);

  useFrame((_, delta) => {
    const ks = keys.current;
    if (ks.size === 0 || !controls) return;
    const dt = Math.min(delta, 0.05);
    camera.getWorldDirection(fwd);
    right.crossVectors(fwd, UP);
    if (right.lengthSq() < 1e-8) right.set(1, 0, 0); // looking straight up/down
    right.normalize();
    // Constant fly speed: half the scene radius per second, zoom-independent,
    // scaled by 이동 감도 (shared with pan).
    const stepLen = Math.max(sceneRadius * 0.5, 0.5) * moveSens * (ks.has("shift") ? 3 : 1) * dt;

    // Strafe + vertical = pan: move camera and target together (distance kept).
    pan.set(0, 0, 0);
    if (ks.has("d") || ks.has("arrowright")) pan.add(right);
    if (ks.has("a") || ks.has("arrowleft")) pan.addScaledVector(right, -1);
    if (ks.has("e") || ks.has(" ")) pan.add(UP);
    if (ks.has("q")) pan.addScaledVector(UP, -1);
    if (pan.lengthSq() > 0) {
      pan.normalize().multiplyScalar(stepLen);
      camera.position.add(pan);
      controls.target.add(pan);
    }

    // Forward/back = true fly: camera and target move together along the view
    // direction at the same constant speed (so you can pass through/beyond the
    // orbit target instead of slowing into it).
    let f = 0;
    if (ks.has("w") || ks.has("arrowup")) f += 1;
    if (ks.has("s") || ks.has("arrowdown")) f -= 1;
    if (f !== 0) {
      dirTC.copy(fwd).multiplyScalar(f * stepLen);
      camera.position.add(dirTC);
      controls.target.add(dirTC);
    }
    controls.update();
  });
  return null;
}
