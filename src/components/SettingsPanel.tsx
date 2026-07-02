import React from "react";
import { type RenderSettings, DEFAULT_SETTINGS } from "../RenderSettings";
import { type GridOpts } from "./SceneObjects";
import { type Bounds } from "../lib/bounds";
import { useDragOffset } from "./FloatingPanel";

// Keys of RenderSettings whose value is a plain number (crop corners are arrays).
type NumKey = { [K in keyof RenderSettings]: RenderSettings[K] extends number ? K : never }[keyof RenderSettings];

const row = { display: "flex", gap: 6, alignItems: "center", fontSize: 14 } as const;

function NumSlider({
  label, k, min, max, step, settings, setSettings, title,
}: {
  label: string; k: NumKey; min: number; max: number; step: number;
  settings: RenderSettings; setSettings: React.Dispatch<React.SetStateAction<RenderSettings>>;
  title?: string;
}) {
  return (
    <label style={row} title={title}>
      <span style={{ width: 84 }}>{label}</span>
      <input type="range" min={min} max={max} step={step} value={settings[k]}
        onChange={(e) => setSettings((s) => ({ ...s, [k]: parseFloat(e.target.value) }))} style={{ flex: 1 }} />
      <span style={{ width: 46, textAlign: "right" }}>{settings[k]}</span>
    </label>
  );
}

/** Section header: a slightly separated bold label to group related controls. */
function Sect({ children }: { children: React.ReactNode }) {
  return <b style={{ marginTop: 6, paddingTop: 6, borderTop: "1px solid rgba(255,255,255,0.12)" }}>{children}</b>;
}

/** Curated quality presets orchestrating every performance knob. Discrete
 * levels (not a continuous slider) because the knobs are heterogeneous —
 * booleans, nonlinear thresholds, quantized strides — so only tested
 * combinations are meaningful. Individual sliders below still override;
 * the matching preset is detected from the current values. */
type Preset = {
  name: string;
  // RenderSettings fields
  s: { lodDist: number; sortThreshold: number; cullThreshold: number; alphaTest: number; minSplatPx: number };
  // scene-level fields
  dprAuto: boolean; dpr: number; minFps: number; renderFrac: number;
};
const PRESETS: Preset[] = [
  { name: "매우낮음", s: { lodDist: 0.5, sortThreshold: 0.03, cullThreshold: 0.02, alphaTest: 0.02, minSplatPx: 2 }, dprAuto: false, dpr: 0.75, minFps: 30, renderFrac: 0.35 },
  { name: "낮음", s: { lodDist: 0.75, sortThreshold: 0.02, cullThreshold: 0.01, alphaTest: 0.01, minSplatPx: 1 }, dprAuto: false, dpr: 1, minFps: 30, renderFrac: 0.6 },
  { name: "중간", s: { lodDist: 1, sortThreshold: 0.015, cullThreshold: 0.005, alphaTest: 0.005, minSplatPx: 0.5 }, dprAuto: true, dpr: 1, minFps: 25, renderFrac: 1 },
  { name: "높음", s: { lodDist: 0, sortThreshold: 0.01, cullThreshold: 0, alphaTest: 0, minSplatPx: 0 }, dprAuto: true, dpr: 1.5, minFps: 15, renderFrac: 1 },
  { name: "최고", s: { lodDist: 0, sortThreshold: 0, cullThreshold: 0, alphaTest: 0, minSplatPx: 0 }, dprAuto: true, dpr: 1.5, minFps: 5, renderFrac: 1 },
];

export interface SceneOpts {
  bg: string; setBg: (v: string) => void;
  showMap: boolean; setShowMap: (v: boolean) => void;
  showGrid: boolean; setShowGrid: (v: boolean) => void;
  grid: GridOpts; setGrid: React.Dispatch<React.SetStateAction<GridOpts>>;
  dpr: number; setDpr: (v: number) => void;
  dprAuto: boolean; setDprAuto: (v: boolean) => void;
  effDpr: number; // what the canvas actually uses (auto-resolved or manual)
  antialias: boolean; setAntialias: (v: boolean) => void; // toggling recreates the GL context
  rotateSens: number; setRotateSens: (v: number) => void; // rotate sensitivity (mouse + touch)
  zoomSens: number; setZoomSens: (v: number) => void; // zoom sensitivity (wheel + pinch)
  moveSens: number; setMoveSens: (v: number) => void; // translation sensitivity (pan + WASD)
  minFps: number; setMinFps: (v: number) => void; // adaptive-DPR floor
  undoCapMB: number; setUndoCapMB: (v: number) => void; // undo/redo snapshot budget
  reloadRenderer: () => void; // remount the splat renderer (worker re-init)
  showAxes: boolean; setShowAxes: (v: boolean) => void;
  renderFrac: number; setRenderFrac: (v: number) => void;
  setView: (dir: [number, number, number]) => void;
  cameraToOrigin: () => void;
  rotateScene: (axis: 0 | 1 | 2, deg: number) => void;
  clipSweep: boolean; setClipSweep: (v: boolean) => void;
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
  const { bg, setBg, showMap, setShowMap, showGrid, setShowGrid, grid, setGrid, dpr, setDpr, dprAuto, setDprAuto, effDpr, antialias, setAntialias, rotateSens, setRotateSens, zoomSens, setZoomSens, moveSens, setMoveSens, minFps, setMinFps, undoCapMB, setUndoCapMB, reloadRenderer, showAxes, setShowAxes, renderFrac, setRenderFrac, setView, cameraToOrigin, rotateScene, clipSweep, setClipSweep, bounds } = scene;
  const disabledLayer = { ...row, opacity: 0.45 } as const;
  const ca = settings.clipAxis;
  const { off, startDrag } = useDragOffset();
  return (
    <div className="scroll" style={{
      position: "absolute", zIndex: 3, top: 46, right: 8, width: "min(280px, calc(100vw - 16px))",
      display: "flex", flexDirection: "column", gap: 6, padding: 10,
      background: "rgba(0,0,0,0.78)", color: "#fff", font: "14px monospace", borderRadius: 6,
      maxHeight: "calc(100dvh - 62px)", overflowY: "auto", transform: `translate(${off.x}px, ${off.y}px)`,
    }}>
      <div onPointerDown={startDrag} style={{
        position: "sticky", top: -10, zIndex: 1, margin: "-10px -10px 2px", padding: "8px 10px",
        background: "rgba(0,0,0,0.92)", display: "flex", justifyContent: "space-between", alignItems: "center",
        cursor: "move", userSelect: "none", touchAction: "none",
      }}>
        <b style={{ pointerEvents: "none" }}>고급 설정</b>
        <button className="ghost icon" onClick={onClose} onPointerDown={(e) => e.stopPropagation()} title="닫기">✕</button>
      </div>

      <b>품질 프리셋</b>
      <div style={{ display: "flex", gap: 4 }}>
        {PRESETS.map((p) => {
          const active =
            settings.lodDist === p.s.lodDist && settings.sortThreshold === p.s.sortThreshold &&
            settings.cullThreshold === p.s.cullThreshold && settings.alphaTest === p.s.alphaTest &&
            settings.minSplatPx === p.s.minSplatPx && dprAuto === p.dprAuto &&
            (p.dprAuto ? minFps === p.minFps : dpr === p.dpr) && renderFrac === p.renderFrac;
          return (
            <button key={p.name} className={active ? "active" : ""} style={{ flex: 1, padding: "6px 2px", fontSize: 12 }}
              onClick={() => {
                setSettings((s) => ({ ...s, ...p.s }));
                setDprAuto(p.dprAuto);
                setDpr(p.dpr);
                setMinFps(p.minFps);
                setRenderFrac(p.renderFrac);
              }}>
              {p.name}
            </button>
          );
        })}
      </div>
      <span style={{ fontSize: 11, opacity: 0.6 }}>프리셋 적용 후 아래 슬라이더로 세부 조정 가능 (수정하면 프리셋 표시 해제)</span>

      <Sect>성능 · 품질</Sect>
      <label style={row} title="자동: 기기 해상도로 렌더하다가 fps가 낮아지면 단계적으로 낮추고, 여유가 생기면 되돌림">
        <span style={{ width: 84 }}>해상도(DPR)</span>
        <input type="checkbox" checked={dprAuto} onChange={(e) => setDprAuto(e.target.checked)} /><span style={{ fontSize: 11 }}>자동</span>
        <input type="range" min={0.5} max={3} step={0.25} value={dprAuto ? effDpr : dpr} disabled={dprAuto}
          onChange={(e) => setDpr(parseFloat(e.target.value))} style={{ flex: 1, opacity: dprAuto ? 0.45 : 1 }} />
        <span style={{ width: 46, textAlign: "right" }}>{Math.round(effDpr * 100) / 100}</span>
      </label>
      <label style={row} title="가우시안이 많아 렉이면 낮추세요 — 일부만 그림 (선택·편집은 전체 유지)">
        <span style={{ width: 84 }}>LOD 비율</span>
        <input type="range" min={0.05} max={1} step={0.05} value={renderFrac} onChange={(e) => setRenderFrac(parseFloat(e.target.value))} style={{ flex: 1 }} />
        <span style={{ width: 46, textAlign: "right" }}>{Math.round(renderFrac * 100)}%</span>
      </label>
      <NumSlider label="정렬 임계값" k="sortThreshold" min={0} max={0.05} step={0.001} settings={settings} setSettings={setSettings}
        title="카메라가 이만큼 회전해야 재정렬 (0 = 항상 정렬, 높을수록 빠르지만 회전 시 번쩍일 수 있음)" />
      <NumSlider label="거리 LOD" k="lodDist" min={0} max={2} step={0.05} settings={settings} setSettings={setSettings}
        title="0 = 끔. 카메라에서 이 거리(씬 반경 배수)까지는 전체 디테일, 그 너머는 가우시안 밀도를 거리 반비례로 낮추고 남은 것을 키워 보정 — 원거리 렌더 부하 절감" />
      <label style={row} title="스플랫에는 효과 없음 — 그리드/기즈모 선의 계단 완화. 켜면 화면이 잠깐 재생성됨">
        <input type="checkbox" checked={antialias} onChange={(e) => setAntialias(e.target.checked)} /> 안티앨리어싱 (MSAA) <span style={{ fontSize: 11, opacity: 0.6 }}>선·그리드용</span>
      </label>
      <label style={row} title="자동 해상도의 기준 fps — 이 아래로 떨어질 때만 해상도를 낮추고, +10 이상 유지되면 되돌림">
        <span style={{ width: 84 }}>최소 fps</span>
        <input type="range" min={5} max={60} step={5} value={minFps} onChange={(e) => setMinFps(parseInt(e.target.value))} style={{ flex: 1 }} />
        <span style={{ width: 46, textAlign: "right" }}>{minFps}</span>
      </label>
      <label style={row} title="undo/redo 스냅샷이 차지할 수 있는 최대 메모리 — 큰 씬에서 편집이 많으면 낮추세요 (한도 초과 시 오래된 기록부터 삭제)">
        <span style={{ width: 84 }}>undo 메모리</span>
        <input type="range" min={64} max={1024} step={64} value={undoCapMB} onChange={(e) => setUndoCapMB(parseInt(e.target.value))} style={{ flex: 1 }} />
        <span style={{ width: 46, textAlign: "right" }}>{undoCapMB}M</span>
      </label>
      <label style={row} title="WASM(SIMD) 대신 순수 JS 정렬 사용 — 호환성 문제 진단용, 켜면 씬이 잠깐 다시 초기화됨">
        <input type="checkbox" checked={settings.jsSort === 1}
          onChange={(e) => { setSettings((s) => ({ ...s, jsSort: e.target.checked ? 1 : 0 })); reloadRenderer(); }} /> JS 정렬 강제 <span style={{ fontSize: 11, opacity: 0.6 }}>호환성용</span>
      </label>

      <Sect>조작</Sect>
      <label style={row} title="드래그 회전 민감도 — 마우스·터치 모두 적용 (터치는 자동으로 약하게 보정됨)">
        <span style={{ width: 84 }}>회전 감도</span>
        <input type="range" min={0.1} max={5} step={0.05} value={rotateSens} onChange={(e) => setRotateSens(parseFloat(e.target.value))} style={{ flex: 1 }} />
        <span style={{ width: 46, textAlign: "right" }}>{rotateSens.toFixed(2)}</span>
      </label>
      <label style={row} title="확대(전진) 민감도 — 휠·핀치 모두 적용">
        <span style={{ width: 84 }}>확대 감도</span>
        <input type="range" min={0.1} max={2} step={0.05} value={zoomSens} onChange={(e) => setZoomSens(parseFloat(e.target.value))} style={{ flex: 1 }} />
        <span style={{ width: 46, textAlign: "right" }}>{zoomSens.toFixed(2)}</span>
      </label>
      <label style={row} title="이동 민감도 — 우클릭 드래그 팬 · 두 손가락 팬 · WASD 모두 적용">
        <span style={{ width: 84 }}>이동 감도</span>
        <input type="range" min={0.1} max={5} step={0.05} value={moveSens} onChange={(e) => setMoveSens(parseFloat(e.target.value))} style={{ flex: 1 }} />
        <span style={{ width: 46, textAlign: "right" }}>{moveSens.toFixed(2)}</span>
      </label>

      <Sect>렌더 (스플랫 모양)</Sect>
      <NumSlider label="splat size" k="splatScale" min={0.1} max={5} step={0.1} settings={settings} setSettings={setSettings} />
      <NumSlider label="min px" k="minSplatPx" min={0} max={20} step={0.5} settings={settings} setSettings={setSettings} />
      <NumSlider label="max px" k="maxSplatPx" min={16} max={2048} step={16} settings={settings} setSettings={setSettings} />
      <NumSlider label="blur" k="blur" min={0} max={2} step={0.05} settings={settings} setSettings={setSettings} />
      <NumSlider label="opacity" k="opacityScale" min={0} max={3} step={0.05} settings={settings} setSettings={setSettings} />
      <NumSlider label="cull" k="cullThreshold" min={0} max={1} step={0.01} settings={settings} setSettings={setSettings} />
      <NumSlider label="falloff" k="falloffCutoff" min={1} max={9} step={0.25} settings={settings} setSettings={setSettings} />
      <NumSlider label="alphaTest" k="alphaTest" min={0} max={0.5} step={0.01} settings={settings} setSettings={setSettings} />
      <NumSlider label="fade" k="fadeSpeed" min={0.1} max={10} step={0.1} settings={settings} setSettings={setSettings} />
      <label style={row} title="PLY에 SH 계수(f_rest)가 있으면 보는 방향에 따라 색이 변함 (반사·광택 표현)">
        <input type="checkbox" checked={settings.shOn === 1} onChange={(e) => setSettings((s) => ({ ...s, shOn: e.target.checked ? 1 : 0 }))} /> 뷰 방향 색 (SH) <span style={{ fontSize: 11, opacity: 0.6 }}>PLY 전용</span>
      </label>
      <button onClick={() => setSettings(DEFAULT_SETTINGS)} style={{ padding: "4px 8px" }}>렌더 설정 초기화</button>

      <Sect>화면 표시</Sect>
      <label style={row}><input type="checkbox" checked={showMap} onChange={(e) => setShowMap(e.target.checked)} /> Gaussian Map</label>
      <label style={row}><input type="checkbox" checked={showAxes} onChange={(e) => setShowAxes(e.target.checked)} /> 축 (Axes)</label>
      <label style={row}><input type="checkbox" checked={showGrid} onChange={(e) => setShowGrid(e.target.checked)} /> 그리드</label>
      {showGrid && (
        <>
          <label style={row}><span style={{ width: 84 }}>grid 색</span><input type="color" value={grid.color} onChange={(e) => setGrid((g) => ({ ...g, color: e.target.value }))} /></label>
          <label style={row}><span style={{ width: 84 }}>grid div</span><input type="range" min={2} max={60} step={1} value={grid.divisions} onChange={(e) => setGrid((g) => ({ ...g, divisions: parseInt(e.target.value) }))} style={{ flex: 1 }} /><span style={{ width: 46, textAlign: "right" }}>{grid.divisions}</span></label>
          <label style={row}><span style={{ width: 84 }}>dash/gap</span><input type="range" min={0.02} max={1} step={0.02} value={grid.dashSize} onChange={(e) => setGrid((g) => ({ ...g, dashSize: parseFloat(e.target.value) }))} style={{ flex: 1 }} /><input type="range" min={0.02} max={1} step={0.02} value={grid.gapSize} onChange={(e) => setGrid((g) => ({ ...g, gapSize: parseFloat(e.target.value) }))} style={{ flex: 1 }} /></label>
        </>
      )}
      <label style={row}><span style={{ width: 84 }}>배경색</span><input type="color" value={bg} onChange={(e) => setBg(e.target.value)} /></label>
      <label style={disabledLayer} title="Viewer Server API 필요"><input type="checkbox" disabled /> Trajectory <span style={{ fontSize: 11 }}>(서버 필요)</span></label>
      <label style={disabledLayer} title="Viewer Server API 필요"><input type="checkbox" disabled /> Camera Pose / Frustum <span style={{ fontSize: 11 }}>(서버 필요)</span></label>
      <label style={disabledLayer} title="Viewer Server API 필요"><input type="checkbox" disabled /> Point Cloud <span style={{ fontSize: 11 }}>(서버 필요)</span></label>

      <Sect>클리핑 (단면)</Sect>
      <label style={row}>
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
            onChange={(e) => { setClipSweep(false); setSettings((s) => ({ ...s, clipPos: parseFloat(e.target.value) })); }}
            style={{ width: "100%" }} />
          <button className={clipSweep ? "active" : ""} onClick={() => setClipSweep(!clipSweep)}>{clipSweep ? "■ 스윕 정지" : "▶ 단면 스윕 애니메이션"}</button>
        </>
      )}

      <Sect>카메라 · 씬</Sect>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <button style={{ flex: 1 }} onClick={() => setView([1, -1, 1])}>대각</button>
        <button style={{ flex: 1 }} onClick={() => setView([0, 0, 1])}>위</button>
        <button style={{ flex: 1 }} onClick={() => setView([0, -1, 0])}>정면</button>
        <button style={{ flex: 1 }} onClick={() => setView([1, 0, 0])}>측면</button>
      </div>
      <button onClick={cameraToOrigin}>카메라를 축(원점) 위치로</button>
      <span style={{ fontSize: 12, opacity: 0.7 }}>씬 회전 (기울기 보정)</span>
      {(["X", "Y", "Z"] as const).map((ax, i) => (
        <div key={ax} className="seg">
          <span className="axis">{ax}</span>
          <button onClick={() => rotateScene(i as 0 | 1 | 2, -5)}>⟲ 5°</button>
          <button onClick={() => rotateScene(i as 0 | 1 | 2, 5)}>⟳ 5°</button>
        </div>
      ))}
    </div>
  );
}
