import React from "react";
import { type RenderSettings, DEFAULT_SETTINGS } from "../RenderSettings";
import { type GridOpts } from "./SceneObjects";
import { type Bounds } from "../lib/bounds";

function NumSlider({
  label, k, min, max, step, settings, setSettings,
}: {
  label: string; k: keyof RenderSettings; min: number; max: number; step: number;
  settings: RenderSettings; setSettings: React.Dispatch<React.SetStateAction<RenderSettings>>;
}) {
  return (
    <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 14 }}>
      <span style={{ width: 84 }}>{label}</span>
      <input type="range" min={min} max={max} step={step} value={settings[k]}
        onChange={(e) => setSettings((s) => ({ ...s, [k]: parseFloat(e.target.value) }))} style={{ flex: 1 }} />
      <span style={{ width: 46, textAlign: "right" }}>{settings[k]}</span>
    </label>
  );
}

export interface SceneOpts {
  bg: string; setBg: (v: string) => void;
  showMap: boolean; setShowMap: (v: boolean) => void;
  showGrid: boolean; setShowGrid: (v: boolean) => void;
  grid: GridOpts; setGrid: React.Dispatch<React.SetStateAction<GridOpts>>;
  dpr: number; setDpr: (v: number) => void;
  showAxes: boolean; setShowAxes: (v: boolean) => void;
  renderFrac: number; setRenderFrac: (v: number) => void;
  setView: (dir: [number, number, number]) => void;
  cameraToOrigin: () => void;
  bookmarks: { p: [number, number, number]; t: [number, number, number] }[];
  saveBookmark: () => void;
  restoreBookmark: (i: number) => void;
  deleteBookmark: (i: number) => void;
  rotateScene: (axis: 0 | 1 | 2, deg: number) => void;
  bounds: Bounds | null;
}

export function SettingsPanel({
  settings, setSettings, scene, onClose,
}: {
  settings: RenderSettings;
  setSettings: React.Dispatch<React.SetStateAction<RenderSettings>>;
  scene: SceneOpts;
  onClose: () => void;
}) {
  const { bg, setBg, showMap, setShowMap, showGrid, setShowGrid, grid, setGrid, dpr, setDpr, showAxes, setShowAxes, renderFrac, setRenderFrac, setView, cameraToOrigin, bookmarks, saveBookmark, restoreBookmark, deleteBookmark, rotateScene, bounds } = scene;
  const disabledLayer = { display: "flex", gap: 6, alignItems: "center", opacity: 0.45 } as const;
  const ca = settings.clipAxis;
  return (
    <div className="scroll" style={{
      position: "absolute", zIndex: 3, top: 46, right: 8, width: "min(280px, calc(100vw - 16px))",
      display: "flex", flexDirection: "column", gap: 6, padding: 10,
      background: "rgba(0,0,0,0.78)", color: "#fff", font: "14px monospace", borderRadius: 6,
      maxHeight: "calc(100dvh - 62px)", overflowY: "auto",
    }}>
      <div style={{
        position: "sticky", top: -10, zIndex: 1, margin: "-10px -10px 2px", padding: "8px 10px",
        background: "rgba(0,0,0,0.92)", display: "flex", justifyContent: "space-between", alignItems: "center",
      }}>
        <b>고급 설정</b>
        <button className="ghost icon" onClick={onClose} title="닫기">✕</button>
      </div>
      <b>shader</b>
      <NumSlider label="splat size" k="splatScale" min={0.1} max={5} step={0.1} settings={settings} setSettings={setSettings} />
      <NumSlider label="min px" k="minSplatPx" min={0} max={20} step={0.5} settings={settings} setSettings={setSettings} />
      <NumSlider label="max px" k="maxSplatPx" min={16} max={2048} step={16} settings={settings} setSettings={setSettings} />
      <NumSlider label="blur" k="blur" min={0} max={2} step={0.05} settings={settings} setSettings={setSettings} />
      <NumSlider label="opacity" k="opacityScale" min={0} max={3} step={0.05} settings={settings} setSettings={setSettings} />
      <NumSlider label="cull" k="cullThreshold" min={0} max={1} step={0.01} settings={settings} setSettings={setSettings} />
      <NumSlider label="falloff" k="falloffCutoff" min={1} max={9} step={0.25} settings={settings} setSettings={setSettings} />
      <NumSlider label="alphaTest" k="alphaTest" min={0} max={0.5} step={0.01} settings={settings} setSettings={setSettings} />
      <NumSlider label="fade" k="fadeSpeed" min={0.1} max={10} step={0.1} settings={settings} setSettings={setSettings} />
      <b>레이어 (Layers)</b>
      <label style={{ display: "flex", gap: 6, alignItems: "center" }}><input type="checkbox" checked={showMap} onChange={(e) => setShowMap(e.target.checked)} /> Gaussian Map</label>
      <label style={{ display: "flex", gap: 6, alignItems: "center" }}><input type="checkbox" checked={showGrid} onChange={(e) => setShowGrid(e.target.checked)} /> Grid</label>
      <label style={{ display: "flex", gap: 6, alignItems: "center" }}><input type="checkbox" checked={showAxes} onChange={(e) => setShowAxes(e.target.checked)} /> Axes</label>
      <label style={disabledLayer} title="Viewer Server API 필요"><input type="checkbox" disabled /> Trajectory <span style={{ fontSize: 11 }}>(서버 필요)</span></label>
      <label style={disabledLayer} title="Viewer Server API 필요"><input type="checkbox" disabled /> Camera Pose / Frustum <span style={{ fontSize: 11 }}>(서버 필요)</span></label>
      <label style={disabledLayer} title="Viewer Server API 필요"><input type="checkbox" disabled /> Point Cloud <span style={{ fontSize: 11 }}>(서버 필요)</span></label>

      <b>scene</b>
      <label style={{ display: "flex", gap: 6, alignItems: "center" }}><span style={{ width: 84 }}>background</span><input type="color" value={bg} onChange={(e) => setBg(e.target.value)} /></label>
      <label style={{ display: "flex", gap: 6, alignItems: "center" }}><span style={{ width: 84 }}>grid 색</span><input type="color" value={grid.color} onChange={(e) => setGrid((g) => ({ ...g, color: e.target.value }))} /></label>
      <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 14 }}><span style={{ width: 84 }}>grid div</span><input type="range" min={2} max={60} step={1} value={grid.divisions} onChange={(e) => setGrid((g) => ({ ...g, divisions: parseInt(e.target.value) }))} style={{ flex: 1 }} /><span style={{ width: 46, textAlign: "right" }}>{grid.divisions}</span></label>
      <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 14 }}><span style={{ width: 84 }}>dash/gap</span><input type="range" min={0.02} max={1} step={0.02} value={grid.dashSize} onChange={(e) => setGrid((g) => ({ ...g, dashSize: parseFloat(e.target.value) }))} style={{ flex: 1 }} /><input type="range" min={0.02} max={1} step={0.02} value={grid.gapSize} onChange={(e) => setGrid((g) => ({ ...g, gapSize: parseFloat(e.target.value) }))} style={{ flex: 1 }} /></label>
      <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 14 }}><span style={{ width: 84 }}>DPR</span><input type="range" min={0.5} max={3} step={0.25} value={dpr} onChange={(e) => setDpr(parseFloat(e.target.value))} style={{ flex: 1 }} /><span style={{ width: 46, textAlign: "right" }}>{dpr}</span></label>
      <button onClick={cameraToOrigin}>카메라를 축(원점) 위치로</button>

      <b>클리핑 (단면)</b>
      <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <input type="checkbox" checked={ca >= 0} disabled={!bounds} onChange={(e) => {
          if (!e.target.checked) setSettings((s) => ({ ...s, clipAxis: -1 }));
          else if (bounds) setSettings((s) => ({ ...s, clipAxis: 0, clipPos: (bounds.min[0] + bounds.max[0]) / 2 }));
        }} /> 단면 보기
      </label>
      {ca >= 0 && bounds && (
        <>
          <div style={{ display: "flex", gap: 6 }}>
            {(["X", "Y", "Z"] as const).map((ax, i) => (
              <button key={ax} className={ca === i ? "active" : ""} style={{ flex: 1 }} onClick={() => setSettings((s) => ({ ...s, clipAxis: i, clipPos: (bounds.min[i] + bounds.max[i]) / 2 }))}>{ax}</button>
            ))}
            <button className="ghost" onClick={() => setSettings((s) => ({ ...s, clipSign: -s.clipSign }))} title="자르는 쪽 반전">⇄</button>
          </div>
          <input type="range"
            min={bounds.min[ca]} max={bounds.max[ca]}
            step={(bounds.max[ca] - bounds.min[ca]) / 200 || 0.001}
            value={settings.clipPos}
            onChange={(e) => setSettings((s) => ({ ...s, clipPos: parseFloat(e.target.value) }))}
            style={{ width: "100%" }} />
        </>
      )}

      <b>성능 (LOD)</b>
      <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 14 }}>
        <span style={{ width: 84 }}>표시 비율</span>
        <input type="range" min={0.05} max={1} step={0.05} value={renderFrac} onChange={(e) => setRenderFrac(parseFloat(e.target.value))} style={{ flex: 1 }} />
        <span style={{ width: 46, textAlign: "right" }}>{Math.round(renderFrac * 100)}%</span>
      </label>
      <span style={{ fontSize: 12, opacity: 0.7 }}>가우시안이 많아 렉이면 낮추세요 (선택·편집은 전체 유지)</span>

      <b>뷰</b>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <button style={{ flex: 1 }} onClick={() => setView([1, -1, 1])}>대각</button>
        <button style={{ flex: 1 }} onClick={() => setView([0, 0, 1])}>위</button>
        <button style={{ flex: 1 }} onClick={() => setView([0, -1, 0])}>정면</button>
        <button style={{ flex: 1 }} onClick={() => setView([1, 0, 0])}>측면</button>
      </div>
      <button onClick={saveBookmark}>현재 시점 북마크 저장</button>
      {bookmarks.map((_, i) => (
        <div key={i} style={{ display: "flex", gap: 6 }}>
          <button style={{ flex: 1 }} onClick={() => restoreBookmark(i)}>북마크 {i + 1}</button>
          <button className="ghost icon" onClick={() => deleteBookmark(i)} title="삭제">✕</button>
        </div>
      ))}

      <b>씬 회전 (기울기 보정)</b>
      {(["X", "Y", "Z"] as const).map((ax, i) => (
        <div key={ax} className="seg">
          <span className="axis">{ax}</span>
          <button onClick={() => rotateScene(i as 0 | 1 | 2, -5)}>⟲ 5°</button>
          <button onClick={() => rotateScene(i as 0 | 1 | 2, 5)}>⟳ 5°</button>
        </div>
      ))}

      <button onClick={() => setSettings(DEFAULT_SETTINGS)} style={{ padding: "4px 8px", marginTop: 4 }}>reset shader</button>
    </div>
  );
}
