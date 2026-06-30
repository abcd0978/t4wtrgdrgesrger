import React from "react";
import * as THREE from "three";
import { useThree } from "@react-three/fiber";
import { type Bounds, center, radius, selCenter } from "../lib/bounds";

export interface GridOpts { color: string; divisions: number; dashSize: number; gapSize: number; }
export interface DragRect { x0: number; y0: number; x1: number; y1: number }

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

/** Publishes a getter for the current camera pos+target (for share URLs). */
export function CameraBridge({ viewRef }: { viewRef: React.MutableRefObject<(() => { p: [number, number, number]; t: [number, number, number] }) | null> }) {
  const camera = useThree((s) => s.camera);
  const controls = useThree((s) => s.controls) as { target?: { x: number; y: number; z: number } } | null;
  React.useEffect(() => {
    viewRef.current = () => ({
      p: [camera.position.x, camera.position.y, camera.position.z],
      t: controls?.target ? [controls.target.x, controls.target.y, controls.target.z] : [0, 0, 0],
    });
    return () => { viewRef.current = null; };
  }, [camera, controls, viewRef]);
  return null;
}

/** Two-point measure: a sphere at each picked point + a connecting line. */
export function MeasureView({ points, size }: { points: [number, number, number][]; size: number }) {
  const lineGeo = React.useMemo(() => {
    if (points.length < 2) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute([...points[0], ...points[1]], 3));
    return g;
  }, [points]);
  return (
    <>
      {points.map((p, i) => (
        <mesh key={i} position={p} renderOrder={20000}>
          <sphereGeometry args={[size, 16, 16]} />
          <meshBasicMaterial color="#00d0ff" depthTest={false} transparent opacity={0.9} />
        </mesh>
      ))}
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

/** Exposes a canvas->PNG capture fn via captureRef (needs `gl`, so lives inside
 * Canvas). Canvas must use preserveDrawingBuffer or toBlob comes back blank. */
export function CanvasCapture({
  captureRef, download,
}: {
  captureRef: React.MutableRefObject<((name: string) => void) | null>;
  download: (blob: Blob, name: string) => void;
}) {
  const gl = useThree((s) => s.gl);
  React.useEffect(() => {
    captureRef.current = (name) =>
      gl.domElement.toBlob((b) => { if (b) download(b, name); }, "image/png");
    return () => { captureRef.current = null; };
  }, [gl, download]);
  return null;
}

/** Drag handle (sphere) at the selection centroid. Drag = move along the camera
 * plane. Built directly (raycast -> plane) because TransformControls' translate
 * is broken in this stack. The handle moves live; gaussians commit on release. */
export function DragMoveHandle({
  buffer, selection, onCommit, size,
}: {
  buffer: Uint32Array | null; selection: Set<number>;
  onCommit: (dx: number, dy: number, dz: number) => void; size: number;
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

  if (!buffer || selection.size === 0) return null;

  function startDrag(e: { stopPropagation: () => void }) {
    e.stopPropagation();
    if (controls) controls.enabled = false;
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
    const onMove = (ev: PointerEvent) => {
      if (!meshRef.current) return;
      if (!started) { if (castTo(ev, last)) started = true; return; }
      if (!castTo(ev, hit)) return;
      const dx = hit.x - last.x, dy = hit.y - last.y, dz = hit.z - last.z;
      meshRef.current.position.x += dx;
      meshRef.current.position.y += dy;
      meshRef.current.position.z += dz;
      total.x += dx; total.y += dy; total.z += dz;
      last.copy(hit);
    };
    const onUp = () => {
      if (controls) controls.enabled = true;
      onCommit(total.x, total.y, total.z);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  return (
    <mesh ref={meshRef} position={pos} onPointerDown={startDrag} renderOrder={20000}>
      <sphereGeometry args={[size, 16, 16]} />
      <meshBasicMaterial color="#ff8800" depthTest={false} transparent opacity={0.85} />
    </mesh>
  );
}
