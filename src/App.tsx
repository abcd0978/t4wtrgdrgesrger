import React from "react";
import * as THREE from "three";
import { Canvas, useThree } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import { SplatRenderContext, SplatObject } from "./splat/GaussianSplats";
import { getDeltaManifest, getAddedNpz, getSnapshot, getRuns, type RunInfo } from "./lib/gaussianApi";
import { unzipNpz, npzToPacked } from "./lib/pack";

interface Bounds { min: [number, number, number]; max: [number, number, number]; }

function concatU32(parts: Uint32Array[]): Uint32Array {
  const total = parts.reduce((a, b) => a + b.length, 0);
  const out = new Uint32Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

function computeBounds(buffer: Uint32Array): Bounds {
  const n = buffer.length / 8;
  const dv = new DataView(buffer.buffer);
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++) {
    const b = i * 32;
    for (let k = 0; k < 3; k++) {
      const v = dv.getFloat32(b + k * 4, true);
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  }
  return { min, max };
}

const center = (b: Bounds): [number, number, number] =>
  [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
const radius = (b: Bounds): number =>
  Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2], 1) * 0.5;

/** Frame the camera (z-up, like viser). */
function FitCamera({ bounds }: { bounds: Bounds }) {
  const camera = useThree((s) => s.camera);
  const controls = useThree((s) => s.controls) as
    | { target: { set: (x: number, y: number, z: number) => void }; update: () => void }
    | null;
  const fitted = React.useRef(false);
  React.useEffect(() => {
    if (fitted.current) return; // fit once per load (don't fight the user / streaming bounds)
    fitted.current = true;
    const c = center(bounds), r = radius(bounds), d = r * 2.5 + 1;
    camera.up.set(0, 0, 1);
    camera.position.set(c[0] + d, c[1] - d, c[2] + d);
    // Generous near/far so splats don't clip when zoomed out.
    camera.near = Math.max(r * 0.001, 0.001);
    camera.far = r * 5000 + 1000;
    camera.updateProjectionMatrix();
    if (controls?.target) { controls.target.set(c[0], c[1], c[2]); controls.update(); }
    else camera.lookAt(c[0], c[1], c[2]);
  }, [bounds, camera, controls]);
  return null;
}

/** Dashed grid on the z=min plane (xy floor), viser-style z-up. */
function DashedGrid({ bounds }: { bounds: Bounds }) {
  const ref = React.useRef<THREE.LineSegments>(null);
  const geo = React.useMemo(() => {
    const c = center(bounds);
    const z = bounds.min[2];
    const span = Math.max(bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1], 1) * 1.6;
    const div = 20, step = span / div, half = span / 2;
    const pts: number[] = [];
    for (let i = 0; i <= div; i++) {
      const o = -half + i * step;
      pts.push(c[0] + o, c[1] - half, z, c[0] + o, c[1] + half, z); // lines along Y
      pts.push(c[0] - half, c[1] + o, z, c[0] + half, c[1] + o, z); // lines along X
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
    return g;
  }, [bounds]);
  React.useEffect(() => { ref.current?.computeLineDistances(); }, [geo]);
  return (
    <lineSegments ref={ref} geometry={geo}>
      <lineDashedMaterial color="#999999" dashSize={0.25} gapSize={0.18} transparent opacity={0.7} />
    </lineSegments>
  );
}

export default function App() {
  const [host, setHost] = React.useState("");
  const [runId, setRunId] = React.useState("online-3dgs-desk-20260624-spnet-gated-full-r2-deltas");
  const [runs, setRuns] = React.useState<RunInfo[]>([]);
  const [mode, setMode] = React.useState<"snapshot" | "delta">("snapshot");
  const [maxFrames, setMaxFrames] = React.useState("100");
  const [showGrid, setShowGrid] = React.useState(true);
  const [buffer, setBuffer] = React.useState<Uint32Array | null>(null);
  const [bounds, setBounds] = React.useState<Bounds | null>(null);
  const [status, setStatus] = React.useState("idle");
  const [busy, setBusy] = React.useState(false);

  // Populate the run dropdown (on mount / host change).
  React.useEffect(() => {
    getRuns(host).then(setRuns).catch(() => setRuns([]));
  }, [host]);

  async function load() {
    setBusy(true);
    setBuffer(null);
    setBounds(null);
    try {
      if (mode === "snapshot") {
        setStatus("fetching snapshot…");
        const merged = npzToPacked(await unzipNpz(await getSnapshot(host, runId)));
        setBuffer(merged);
        setBounds(computeBounds(merged));
        setStatus(`done: ${merged.length / 8} gaussians`);
      } else {
        setStatus("fetching manifest…");
        const manifest = await getDeltaManifest(host, runId);
        const limit = Math.min(manifest.frames.length, parseInt(maxFrames) || manifest.frames.length);
        const packs: Uint32Array[] = [];
        // Refresh a bounded number of times (each refresh rebuilds splat
        // textures). pack/unzip are synchronous, so we must yield after each
        // push or the rAF render loop never runs and nothing appears.
        const updateEvery = Math.max(1, Math.floor(limit / 12));
        for (let i = 0; i < limit; i++) {
          const f = manifest.frames[i];
          packs.push(npzToPacked(await unzipNpz(await getAddedNpz(host, runId, f.frame_index))));
          if ((i + 1) % updateEvery === 0 || i === limit - 1) {
            const merged = concatU32(packs);
            setBuffer(merged);
            setBounds(computeBounds(merged));
            setStatus(`streaming ${i + 1}/${limit} — ${merged.length / 8} gaussians`);
            await new Promise((r) => setTimeout(r, 0)); // yield: let React commit + paint
          }
        }
      }
    } catch (e) {
      setStatus("error: " + (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ position: "fixed", inset: 0 }}>
      <div
        style={{
          position: "absolute", zIndex: 1, top: 0, left: 0, right: 0,
          display: "flex", gap: 6, padding: 8, alignItems: "center", flexWrap: "wrap",
          background: "rgba(0,0,0,0.65)", color: "#fff", font: "13px monospace",
        }}
      >
        <input value={host} onChange={(e) => setHost(e.target.value)} placeholder="(empty = this server)" style={{ flex: 1, minWidth: 130, padding: 4 }} />
        <select value={runId} onChange={(e) => setRunId(e.target.value)} style={{ flex: 2, minWidth: 180, padding: 4 }}>
          {runs.length === 0 && <option value={runId}>{runId}</option>}
          {runs.map((r) => (
            <option key={r.runId} value={r.runId}>{r.runId} ({r.gaussians})</option>
          ))}
        </select>
        <select value={mode} onChange={(e) => setMode(e.target.value as "snapshot" | "delta")} style={{ padding: 4 }}>
          <option value="snapshot">snapshot</option>
          <option value="delta">delta</option>
        </select>
        {mode === "delta" && (
          <input value={maxFrames} onChange={(e) => setMaxFrames(e.target.value)} title="max delta frames" style={{ width: 55, padding: 4 }} />
        )}
        <label style={{ display: "flex", alignItems: "center", gap: 3 }}>
          <input type="checkbox" checked={showGrid} onChange={(e) => setShowGrid(e.target.checked)} />grid
        </label>
        <button onClick={load} disabled={busy} style={{ padding: "4px 12px" }}>{busy ? "…" : "Load"}</button>
        <span style={{ flex: 2, minWidth: 120 }}>{status}</span>
      </div>

      <Canvas camera={{ position: [5, -5, 5], up: [0, 0, 1], near: 0.01, far: 1000 }}>
        <color attach="background" args={["#ffffff"]} />
        <OrbitControls makeDefault />
        {showGrid && bounds && <DashedGrid bounds={bounds} />}
        {buffer && bounds && (
          <>
            <FitCamera bounds={bounds} />
            <SplatRenderContext>
              <SplatObject buffer={buffer} />
            </SplatRenderContext>
          </>
        )}
      </Canvas>
    </div>
  );
}
