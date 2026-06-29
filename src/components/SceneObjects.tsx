import React from "react";
import * as THREE from "three";
import { useThree } from "@react-three/fiber";
import { TransformControls } from "@react-three/drei";
import { type Bounds, center, radius, selCenter } from "../lib/bounds";

export interface GridOpts { color: string; divisions: number; dashSize: number; gapSize: number; }
export interface DragRect { x0: number; y0: number; x1: number; y1: number }

/** Fit the camera to the data once (z-up, like viser). */
export function FitCamera({ bounds }: { bounds: Bounds }) {
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

/** Double-click = single pick; double-click + drag = box select. Plain drag = camera. */
export function InputController({
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
        let best = -1, bestD = 400;
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

/** Translate gizmo; reports incremental deltas live while dragging.
 * Uses the `dragging-changed` event to lock the orbit camera IMMEDIATELY
 * (a state flag would lag a frame and let the camera eat the first drag). */
export function MoveGizmo({
  selection, buffer, onStart, onMove, onEnd, setGizmoDragging,
}: {
  selection: Set<number>; buffer: Uint32Array | null;
  onStart: () => void; onMove: (dx: number, dy: number, dz: number) => void; onEnd: () => void;
  setGizmoDragging: (b: boolean) => void;
}) {
  const gref = React.useRef<THREE.Group>(null);
  const last = React.useRef(new THREE.Vector3());
  const controls = useThree((s) => s.controls) as { enabled: boolean } | null;

  React.useEffect(() => {
    if (gref.current && buffer && selection.size > 0) {
      const c = selCenter(buffer, selection);
      gref.current.position.set(c[0], c[1], c[2]);
      last.current.set(c[0], c[1], c[2]);
    }
  }, [selection, buffer]);

  if (!buffer || selection.size === 0) return null;
  return (
    <TransformControls
      mode="translate"
      onMouseDown={() => {
        if (controls) controls.enabled = false; // lock camera immediately, this frame
        setGizmoDragging(true);
        if (gref.current) last.current.copy(gref.current.position);
        onStart();
      }}
      onObjectChange={() => {
        if (!gref.current) return;
        const p = gref.current.position;
        const dx = p.x - last.current.x, dy = p.y - last.current.y, dz = p.z - last.current.z;
        if (dx || dy || dz) { onMove(dx, dy, dz); last.current.copy(p); }
      }}
      onMouseUp={() => {
        if (controls) controls.enabled = true;
        setGizmoDragging(false);
        onEnd();
      }}
    >
      <group ref={gref}>
        {/* invisible anchor so TransformControls has a real object to attach to */}
        <mesh visible={false}>
          <boxGeometry args={[0.01, 0.01, 0.01]} />
          <meshBasicMaterial />
        </mesh>
      </group>
    </TransformControls>
  );
}
