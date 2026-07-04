/** Tiny inline bar histogram for the stats panel. */
export function Hist({ data, label, sub }: { data: number[]; label: string; sub?: string }) {
  const max = Math.max(...data, 1);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <span className="muted" style={{ fontSize: 11 }}>{label}</span>
        {sub && <span className="num muted" style={{ fontSize: 10 }}>{sub}</span>}
      </div>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 1, height: 34 }}>
        {data.map((v, i) => (
          <div key={i} style={{ flex: 1, height: `${(v / max) * 100}%`, minHeight: v > 0 ? 2 : 0, background: "var(--accent)", opacity: 0.8, borderRadius: 1 }} />
        ))}
      </div>
    </div>
  );
}

/** Keyboard / gesture cheat-sheet rows shown in the help panel. */
export const HELP: [string, string][] = [
  ["드래그", "카메라 회전"],
  ["스크롤", "확대 / 축소"],
  ["WASD / 방향키", "카메라 이동 (Shift: 빠르게, Q·E: 아래·위)"],
  ["더블클릭", "맨 앞 가우시안 선택 (Shift: 누적)"],
  ["◆ 다면체 선택", "도구 ▾ → 가우시안 4점 이상으로 입체 도형을 만들어 그 안을 선택"],
  ["길게 누르기 (0.5초)", "그 지점을 회전축(피벗)으로"],
  ["주황 구 드래그", "선택 이동 (실시간)"],
  ["초록 링 드래그", "선택 회전 (실시간, 시점축 기준)"],
  ["왼쪽 패널", "이동·회전·스케일·색·복제·숨기기·격리·삭제"],
  ["측정 버튼", "두 점 더블클릭 → 실측 거리"],
  ["타임라인 (delta)", "▶ 재생 · 속도 · 구간 지정 → 구간 .ply"],
  ["PLY 열기 / 내보내기 / 공유", "로컬 .ply 로드 · .ply 저장 · 링크"],
  ["스크린샷", "현재 화면 PNG 저장"],
  ["undo / redo / reset", "Ctrl+Z / Ctrl+Shift+Z / 처음으로"],
  ["Delete / Esc", "선택 삭제 / 선택 해제"],
  ["⚙ 버튼", "렌더 설정 열기"],
];
