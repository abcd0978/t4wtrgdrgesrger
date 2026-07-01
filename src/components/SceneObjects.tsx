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

/** Fit the camera to the data (z-up, like viser). Repositions only on the first
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
    const c = center(bounds), d = r * 2.5 + 1;
    camera.up.set(0, 0, 1);
    camera.position.set(c[0] + d, c[1] - d, c[2] + d);
    if (controls?.target) { controls.target.set(c[0], c[1], c[2]); controls.update(); }
    else camera.lookAt(c[0], c[1], c[2]);
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
    };
    return () => { apiRef.current = null; };
  }, [camera, controls, apiRef]);
  return null;
}

/** Two-point measure: a sphere at each picked point + a connecting line. */
export function MeasureView({ points }: { points: [number, number, number][] }) {
  const lineGeo = React.useMemo(() => {
    if (points.length < 2) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute([...points[0], ...points[1]], 3));
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

/** Double-click = single pick; double-click + drag = box select. Plain drag = camera.
 * In measure mode a single double-click instead reports the picked gaussian's
 * world position (for the two-point distance tool). */
export function InputController({
  bufferRef, selectionRef, setSelection, setDrag, setSelecting, measureMode, onMeasurePick,
}: {
  bufferRef: React.MutableRefObject<Uint32Array | null>;
  selectionRef: React.MutableRefObject<Set<number>>;
  setSelection: (s: Set<number>) => void;
  setDrag: (d: DragRect | null) => void;
  setSelecting: (b: boolean) => void;
  measureMode: boolean;
  onMeasurePick: (p: [number, number, number]) => void;
}) {
  const gl = useThree((s) => s.gl);
  const camera = useThree((s) => s.camera);
  const size = useThree((s) => s.size);
  const controls = useThree((s) => s.controls) as { enabled: boolean } | null;
  const env = React.useRef({ camera, w: size.width, h: size.height, measureMode, onMeasurePick });
  env.current = { camera, w: size.width, h: size.height, measureMode, onMeasurePick };

  React.useEffect(() => {
    const el = gl.domElement;
    let lastUp = 0, lx = 0, ly = 0, sel = false, sx = 0, sy = 0;

    // Nearest visible gaussian to a screen point, or -1.
    function pickNearest(x0: number, y0: number): number {
      const buffer = bufferRef.current;
      if (!buffer) return -1;
      const { camera, w, h } = env.current;
      const dv = new DataView(buffer.buffer);
      const n = buffer.length / 8;
      const v = new THREE.Vector3();
      let best = -1, bestD = 400;
      for (let i = 0; i < n; i++) {
        const b = i * 32; if (dv.getUint8(b + 31) === 0) continue;
        v.set(dv.getFloat32(b, true), dv.getFloat32(b + 4, true), dv.getFloat32(b + 8, true)).project(camera);
        if (v.z < -1 || v.z > 1) continue;
        const px = (v.x * 0.5 + 0.5) * w, py = (-v.y * 0.5 + 0.5) * h;
        const d = (px - x0) ** 2 + (py - y0) ** 2;
        if (d < bestD) { bestD = d; best = i; }
      }
      return best;
    }

    function pick(x0: number, y0: number, x1: number, y1: number, additive: boolean, single: boolean) {
      const buffer = bufferRef.current;
      if (!buffer) return;
      const out = additive ? new Set(selectionRef.current) : new Set<number>();
      if (single) {
        const best = pickNearest(x0, y0);
        if (best >= 0) out.add(best);
      } else {
        const { camera, w, h } = env.current;
        const dv = new DataView(buffer.buffer);
        const n = buffer.length / 8;
        const v = new THREE.Vector3();
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

    function measure(x0: number, y0: number) {
      const buffer = bufferRef.current;
      const idx = pickNearest(x0, y0);
      if (idx < 0 || !buffer) return;
      const dv = new DataView(buffer.buffer);
      const b = idx * 32;
      env.current.onMeasurePick([dv.getFloat32(b, true), dv.getFloat32(b + 4, true), dv.getFloat32(b + 8, true)]);
    }

    const down = (e: PointerEvent) => {
      const now = performance.now();
      if (now - lastUp < 300 && Math.hypot(e.clientX - lx, e.clientY - ly) < 12) {
        // double-click: start box select, lock the camera directly
        sel = true; sx = e.clientX; sy = e.clientY;
        if (controls) controls.enabled = false;
        setSelecting(true);
        setDrag({ x0: sx, y0: sy, x1: sx, y1: sy });
      }
    };
    const move = (e: PointerEvent) => { if (sel) setDrag({ x0: sx, y0: sy, x1: e.clientX, y1: e.clientY }); };
    const up = (e: PointerEvent) => {
      if (sel) {
        const dist = Math.hypot(e.clientX - sx, e.clientY - sy);
        if (env.current.measureMode) { if (dist < 5) measure(sx, sy); }
        else pick(sx, sy, e.clientX, e.clientY, e.shiftKey, dist < 5);
        sel = false; if (controls) controls.enabled = true; setSelecting(false); setDrag(null);
      }
      lastUp = performance.now(); lx = e.clientX; ly = e.clientY;
    };
    // NOTE: bubble phase (not capture) so the gizmo/orbit get pointerdown first.
    el.addEventListener("pointerdown", down);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      el.removeEventListener("pointerdown", down);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [gl, controls, bufferRef, selectionRef, setSelection, setDrag, setSelecting]);
  return null;
}

/** Exposes a canvas->PNG capture fn via captureRef and the canvas element via
 * canvasRef (for video recording). Needs `gl`, so lives inside Canvas; Canvas
 * must use preserveDrawingBuffer or toBlob comes back blank. */
export function CanvasCapture({
  captureRef, canvasRef, download,
}: {
  captureRef: React.MutableRefObject<((name: string) => void) | null>;
  canvasRef?: React.MutableRefObject<HTMLCanvasElement | null>;
  download: (blob: Blob, name: string) => void;
}) {
  const gl = useThree((s) => s.gl);
  React.useEffect(() => {
    captureRef.current = (name) =>
      gl.domElement.toBlob((b) => { if (b) download(b, name); }, "image/png");
    if (canvasRef) canvasRef.current = gl.domElement;
    return () => { captureRef.current = null; if (canvasRef) canvasRef.current = null; };
  }, [gl, download, canvasRef]);
  return null;
}

export type CamPose = { p: [number, number, number]; t: [number, number, number]; ms: number };

/** Interpolated camera pose at time `ms` along a recorded path. */
function poseAt(path: CamPose[], ms: number): CamPose | null {
  if (path.length === 0) return null;
  if (ms <= path[0].ms) return path[0];
  const last = path[path.length - 1];
  if (ms >= last.ms) return last;
  let i = 1;
  while (i < path.length && path[i].ms < ms) i++;
  const a = path[i - 1], b = path[i];
  const u = (ms - a.ms) / ((b.ms - a.ms) || 1);
  const lp = (k: number) => a.p[k] + (b.p[k] - a.p[k]) * u;
  const lt = (k: number) => a.t[k] + (b.t[k] - a.t[k]) * u;
  return { p: [lp(0), lp(1), lp(2)], t: [lt(0), lt(1), lt(2)], ms };
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

/** Scale OrbitControls rotate speed by how close the camera is to actual content
 * (nearest gaussian, sub-sampled), not the orbit target — so rotation stays calm
 * whenever you're near the data, however you got there (zoom, fly, or teleport).
 * Falls back to camera↔target distance when there's no buffer. */
export function AdaptiveRotateSpeed({
  sceneRadius, bufferRef,
}: {
  sceneRadius: number;
  bufferRef: React.MutableRefObject<Uint32Array | null>;
}) {
  const camera = useThree((s) => s.camera);
  const controls = useThree((s) => s.controls) as { target: THREE.Vector3; rotateSpeed: number } | null;
  useFrame(() => {
    if (!controls) return;
    const buf = bufferRef.current;
    let dist = camera.position.distanceTo(controls.target);
    if (buf) {
      const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
      const n = buf.length / 8;
      const step = Math.max(1, Math.floor(n / 2000));
      const cx = camera.position.x, cy = camera.position.y, cz = camera.position.z;
      let min2 = Infinity;
      for (let i = 0; i < n; i += step) {
        const b = i * 32;
        if (dv.getUint8(b + 31) === 0) continue;
        const dx = dv.getFloat32(b, true) - cx, dy = dv.getFloat32(b + 4, true) - cy, dz = dv.getFloat32(b + 8, true) - cz;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < min2) min2 = d2;
      }
      if (min2 < Infinity) dist = Math.sqrt(min2);
    }
    controls.rotateSpeed = Math.min(1, Math.max(0.1, dist / (sceneRadius || 1)));
  });
  return null;
}

/** WASD / arrow-key fly: translate camera + orbit target together so it reads as
 * moving through the scene. Speed scales with the orbit distance (so it works at
 * any zoom); Shift = faster, Q/E (or Space) = down/up along world-up (z). */
const FLY_KEYS = new Set(["w", "a", "s", "d", "q", "e", " ", "shift", "arrowup", "arrowdown", "arrowleft", "arrowright"]);

export function KeyboardFly() {
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
    const dist = camera.position.distanceTo(controls.target);
    const stepLen = Math.max(dist * 0.8, 0.5) * (ks.has("shift") ? 3 : 1) * dt;

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

    // Forward/back = dolly toward/away from the target, exactly like wheel zoom:
    // camera-only, so the distance (and thus the speed) shrinks as you approach.
    let f = 0;
    if (ks.has("w") || ks.has("arrowup")) f += 1;
    if (ks.has("s") || ks.has("arrowdown")) f -= 1;
    if (f !== 0 && dist > 1e-6) {
      const newDist = Math.max(1e-4, dist - f * stepLen);
      dirTC.copy(camera.position).sub(controls.target).normalize();
      camera.position.copy(controls.target).addScaledVector(dirTC, newDist);
    }
    controls.update();
  });
  return null;
}
