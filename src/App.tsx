import React from "react";
import { Canvas, useThree } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import { SplatRenderContext, SplatObject } from "./splat/GaussianSplats";
import { getDeltaManifest, getAddedNpz } from "./lib/gaussianApi";
import { unzipNpz, npzToPacked } from "./lib/pack";

function concatU32(parts: Uint32Array[]): Uint32Array {
  const total = parts.reduce((a, b) => a + b.length, 0);
  const out = new Uint32Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Frame the camera on the loaded gaussians (centers live at word 0..2 of each 32B record). */
function FitCamera({ buffer }: { buffer: Uint32Array }) {
  const camera = useThree((s) => s.camera);
  const controls = useThree((s) => s.controls) as { target: { set: (x: number, y: number, z: number) => void }; update: () => void } | null;
  React.useEffect(() => {
    const n = buffer.length / 8;
    if (n === 0) return;
    const dv = new DataView(buffer.buffer);
    let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < n; i++) {
      const b = i * 32;
      const x = dv.getFloat32(b, true), y = dv.getFloat32(b + 4, true), z = dv.getFloat32(b + 8, true);
      if (x < minX) minX = x; if (y < minY) minY = y; if (z < minZ) minZ = z;
      if (x > maxX) maxX = x; if (y > maxY) maxY = y; if (z > maxZ) maxZ = z;
    }
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2, cz = (minZ + maxZ) / 2;
    const r = Math.max(maxX - minX, maxY - minY, maxZ - minZ, 1) * 0.5;
    const d = r * 2.5 + 1;
    camera.position.set(cx + d, cy + d, cz + d);
    camera.near = Math.max(d / 1000, 0.001);
    camera.far = d * 100;
    camera.updateProjectionMatrix();
    if (controls) {
      controls.target.set(cx, cy, cz);
      controls.update();
    } else {
      camera.lookAt(cx, cy, cz);
    }
  }, [buffer, camera, controls]);
  return null;
}

export default function App() {
  // Empty host = same-origin "/api" — works when this build is served BY the
  // gaussian server itself (no CORS, no tunnel). For separate dev, type the
  // absolute URL e.g. http://localhost:8767.
  const [host, setHost] = React.useState("");
  const [runId, setRunId] = React.useState("online-3dgs-desk-20260624-spnet-gated-full-r2-deltas");
  const [maxFrames, setMaxFrames] = React.useState("100");
  const [buffer, setBuffer] = React.useState<Uint32Array | null>(null);
  const [status, setStatus] = React.useState("idle");
  const [busy, setBusy] = React.useState(false);

  async function load() {
    setBusy(true);
    setBuffer(null);
    try {
      setStatus("fetching manifest…");
      const manifest = await getDeltaManifest(host, runId);
      const limit = Math.min(manifest.frames.length, parseInt(maxFrames) || manifest.frames.length);
      const packs: Uint32Array[] = [];
      for (let i = 0; i < limit; i++) {
        const f = manifest.frames[i];
        const npz = await getAddedNpz(host, runId, f.frame_index);
        packs.push(npzToPacked(await unzipNpz(npz)));
        if (i % 5 === 0 || i === limit - 1) setStatus(`frame ${i + 1}/${limit}`);
      }
      const merged = concatU32(packs);
      setBuffer(merged);
      setStatus(`done: ${merged.length / 8} gaussians from ${packs.length} deltas`);
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
          display: "flex", gap: 8, padding: 8, alignItems: "center", flexWrap: "wrap",
          background: "rgba(0,0,0,0.6)", color: "#fff", font: "13px monospace",
        }}
      >
        <input value={host} onChange={(e) => setHost(e.target.value)} placeholder="(empty = this server)" style={{ flex: 2, minWidth: 160, padding: 4 }} />
        <input value={runId} onChange={(e) => setRunId(e.target.value)} placeholder="run id" style={{ flex: 3, minWidth: 200, padding: 4 }} />
        <input value={maxFrames} onChange={(e) => setMaxFrames(e.target.value)} title="max delta frames" style={{ width: 60, padding: 4 }} />
        <button onClick={load} disabled={busy} style={{ padding: "4px 12px" }}>{busy ? "…" : "Load"}</button>
        <span style={{ flex: 2 }}>{status}</span>
      </div>

      <Canvas camera={{ position: [0, 0, 5], near: 0.01, far: 1000 }}>
        <color attach="background" args={["#ffffff"]} />
        <OrbitControls makeDefault />
        {buffer && (
          <>
            <FitCamera buffer={buffer} />
            <SplatRenderContext>
              <SplatObject buffer={buffer} />
            </SplatRenderContext>
          </>
        )}
      </Canvas>
    </div>
  );
}
