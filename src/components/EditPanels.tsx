import { FloatingPanel } from "./FloatingPanel";

type Axis = 0 | 1 | 2;
type GroupItem = { id: number; name: string; indices: number[]; hidden: boolean; color: string };

/** Left panel: transform / colour / duplicate / hide / delete the current selection. */
export function SelectionPanel({
  selectionSize, onDeselect, onInvert, onGrow,
  moveStep, setMoveStep, onMove,
  rotStep, setRotStep, onRotate,
  onScaleUniform, onScaleAxis,
  editColor, setEditColor, editAlpha, setEditAlpha, onApplyColor,
  onDuplicate, onHide, onIsolate, onDelete, onKeepOnly, onExportSel,
}: {
  selectionSize: number;
  onDeselect: () => void; onInvert: () => void; onGrow: () => void;
  moveStep: number; setMoveStep: (v: number) => void; onMove: (dx: number, dy: number, dz: number) => void;
  rotStep: number; setRotStep: (v: number) => void; onRotate: (axis: Axis, deg: number) => void;
  onScaleUniform: (f: number) => void; onScaleAxis: (sx: number, sy: number, sz: number) => void;
  editColor: string; setEditColor: (v: string) => void; editAlpha: number; setEditAlpha: (v: number) => void; onApplyColor: () => void;
  onDuplicate: () => void; onHide: () => void; onIsolate: () => void; onDelete: () => void; onKeepOnly: () => void; onExportSel: () => void;
}) {
  return (
    <FloatingPanel title={`선택 ${selectionSize.toLocaleString()}개`} onClose={onDeselect} style={{ top: 62, left: 10 }} width="min(214px, calc(100vw - 20px))">
        <div className="row">
          <button className="grow" onClick={onInvert}>선택 반전</button>
          <button className="grow" onClick={onGrow} title="선택 영역(박스)을 채워 확장">확장</button>
        </div>

        <label className="row muted">이동
          <input type="range" className="grow" min={0.01} max={1} step={0.01} value={Math.min(moveStep, 1)} onChange={(e) => setMoveStep(parseFloat(e.target.value))} />
          <input type="number" className="num" min={0} step={0.05} value={moveStep} onChange={(e) => setMoveStep(Math.max(0, parseFloat(e.target.value) || 0))} style={{ width: 54 }} />
        </label>
        {([["X", 0], ["Y", 1], ["Z", 2]] as const).map(([ax, i]) => (
          <div key={ax} className="seg">
            <span className="axis">{ax}</span>
            <button onClick={() => onMove(i === 0 ? -moveStep : 0, i === 1 ? -moveStep : 0, i === 2 ? -moveStep : 0)}>−</button>
            <button onClick={() => onMove(i === 0 ? moveStep : 0, i === 1 ? moveStep : 0, i === 2 ? moveStep : 0)}>＋</button>
          </div>
        ))}

        <hr className="divider" />
        <div className="muted">회전 / 스케일</div>
        <label className="row muted">각도
          <input type="range" className="grow" min={1} max={90} step={1} value={Math.min(rotStep, 90)} onChange={(e) => setRotStep(parseInt(e.target.value))} />
          <input type="number" className="num" min={0} max={360} step={1} value={rotStep} onChange={(e) => setRotStep(Math.max(0, parseInt(e.target.value) || 0))} style={{ width: 54 }} />
        </label>
        {(["X", "Y", "Z"] as const).map((ax, i) => (
          <div key={ax} className="seg">
            <span className="axis">{ax}</span>
            <button onClick={() => onRotate(i as Axis, -rotStep)}>⟲</button>
            <button onClick={() => onRotate(i as Axis, rotStep)}>⟳</button>
          </div>
        ))}
        <div className="seg">
          <span className="axis">⤢</span>
          <button onClick={() => onScaleUniform(1 / 1.1)}>− 균등</button>
          <button onClick={() => onScaleUniform(1.1)}>＋ 균등</button>
        </div>
        <div className="muted" style={{ fontSize: 12 }}>축별 스케일</div>
        {(["X", "Y", "Z"] as const).map((ax, i) => (
          <div key={"s" + ax} className="seg">
            <span className="axis">{ax}</span>
            <button onClick={() => onScaleAxis(i === 0 ? 1 / 1.1 : 1, i === 1 ? 1 / 1.1 : 1, i === 2 ? 1 / 1.1 : 1)}>−</button>
            <button onClick={() => onScaleAxis(i === 0 ? 1.1 : 1, i === 1 ? 1.1 : 1, i === 2 ? 1.1 : 1)}>＋</button>
          </div>
        ))}

        <hr className="divider" />
        <label className="row muted">색
          <input type="color" value={editColor} onChange={(e) => setEditColor(e.target.value)} />
          <span className="grow" />
          <span className="num">α</span>
          <input type="range" min={0} max={1} step={0.01} value={editAlpha} onChange={(e) => setEditAlpha(parseFloat(e.target.value))} style={{ width: 72 }} />
        </label>
        <button onClick={onApplyColor}>색·불투명도 적용</button>

        <hr className="divider" />
        <div className="row">
          <button className="grow" onClick={onDuplicate}>복제</button>
          <button className="grow" onClick={onHide}>숨기기</button>
        </div>
        <div className="row">
          <button className="grow" onClick={onIsolate}>격리</button>
          <button className="grow danger" onClick={onDelete}>삭제</button>
        </div>
        <button className="danger" onClick={onKeepOnly} title="선택하지 않은 가우시안을 전부 삭제 (undo 가능)">✂ 선택만 남기기</button>
        <button onClick={onExportSel}>선택만 .ply 내보내기</button>
    </FloatingPanel>
  );
}

/** Right panel: select gaussians by colour similarity or opacity range. */
export function FilterPanel({
  onClose, filterAdd, setFilterAdd,
  filterColor, setFilterColor, onPickColor, canPick,
  filterTol, setFilterTol, onFilterColor,
  filterOpMin, setFilterOpMin, filterOpMax, setFilterOpMax, onFilterOpacity,
}: {
  onClose: () => void; filterAdd: boolean; setFilterAdd: (v: boolean) => void;
  filterColor: string; setFilterColor: (v: string) => void; onPickColor: () => void; canPick: boolean;
  filterTol: number; setFilterTol: (v: number) => void; onFilterColor: () => void;
  filterOpMin: number; setFilterOpMin: (v: number) => void; filterOpMax: number; setFilterOpMax: (v: number) => void; onFilterOpacity: () => void;
}) {
  return (
    <FloatingPanel title="🔎 필터 선택" onClose={onClose} style={{ top: 62, right: 8 }} width="min(230px, calc(100vw - 20px))">
        <label className="row"><input type="checkbox" checked={filterAdd} onChange={(e) => setFilterAdd(e.target.checked)} /> 기존 선택에 추가</label>

        <hr className="divider" />
        <div className="muted">색 유사도</div>
        <label className="row">색
          <input type="color" value={filterColor} onChange={(e) => setFilterColor(e.target.value)} />
          <span className="grow" />
          <button className="ghost" onClick={onPickColor} disabled={!canPick} title="선택의 평균색">선택색</button>
        </label>
        <label className="row muted">허용
          <input type="range" className="grow" min={0} max={300} step={5} value={filterTol} onChange={(e) => setFilterTol(parseInt(e.target.value))} />
          <span className="num" style={{ width: 32, textAlign: "right" }}>{filterTol}</span>
        </label>
        <button onClick={onFilterColor}>이 색으로 선택</button>

        <hr className="divider" />
        <div className="muted">불투명도 범위 (0–255)</div>
        <div className="row">
          <input type="number" className="num grow" min={0} max={255} value={filterOpMin} onChange={(e) => setFilterOpMin(Math.max(0, parseInt(e.target.value) || 0))} />
          <span className="muted">~</span>
          <input type="number" className="num grow" min={0} max={255} value={filterOpMax} onChange={(e) => setFilterOpMax(Math.max(0, parseInt(e.target.value) || 0))} />
        </div>
        <button onClick={onFilterOpacity}>불투명도로 선택</button>
    </FloatingPanel>
  );
}

/** Right panel: save selections as groups and reselect / hide / recolor / remove. */
export function GroupPanel({
  onClose, selectionSize, groups, onCreate, onSelect, onToggleHide, onRecolor, onRemove,
}: {
  onClose: () => void; selectionSize: number; groups: GroupItem[];
  onCreate: () => void; onSelect: (g: GroupItem) => void; onToggleHide: (id: number) => void;
  onRecolor: (id: number, color: string) => void; onRemove: (id: number) => void;
}) {
  return (
    <FloatingPanel title="🗂 그룹" onClose={onClose} style={{ top: 62, right: 8 }} width="min(240px, calc(100vw - 20px))">
        <button onClick={onCreate} disabled={selectionSize === 0}>선택을 그룹으로 ({selectionSize.toLocaleString()})</button>
        {groups.length === 0 && <span className="muted" style={{ fontSize: 12 }}>그룹 없음. 선택 후 위 버튼으로 저장.</span>}
        {groups.map((g) => (
          <div key={g.id} className="row" style={{ gap: 5 }}>
            <input type="color" value={g.color} onChange={(e) => onRecolor(g.id, e.target.value)} title="그룹 색 적용" style={{ width: 26, height: 26, padding: 2, flex: "0 0 auto" }} />
            <button className="grow" style={{ textAlign: "left", overflow: "hidden", whiteSpace: "nowrap", opacity: g.hidden ? 0.5 : 1 }} onClick={() => onSelect(g)} title="재선택">{g.name} · {g.indices.length.toLocaleString()}</button>
            <button className="ghost icon" onClick={() => onToggleHide(g.id)} title={g.hidden ? "보이기" : "숨기기"}>{g.hidden ? "🚫" : "👁"}</button>
            <button className="ghost icon" onClick={() => onRemove(g.id)} title="그룹 해제(가우시안 유지)">✕</button>
          </div>
        ))}
    </FloatingPanel>
  );
}
