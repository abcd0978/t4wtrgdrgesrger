# 변경 내역 (Changelog)

## 편집 기능 5종 + 수학 유틸 분리

브라우저 단독 가우시안 뷰어에 "편집 → 저장" 워크플로 추가. 로드맵 #2·#4·#10·#11·#12 구현.

### ✏️ 편집 / 데이터
- **삭제 (#2)** — 선택 패널 `삭제`. alpha 0 처리(기존 빈-슬롯 규약 재사용)로 렌더·선택·바운드·내보내기에서 모두 제외. undo 가능, 내보내기 시 영구 반영.
- **색 / 불투명도 일괄변경 (#4)** — 선택 패널의 색 picker + 불투명도 슬라이더 + `적용`. 선택한 가우시안의 rgba를 한 번에 설정.
- **내보내기 .ply (#10)** — 표준 3DGS 바이너리 PLY 다운로드. 공분산(upper-tri f16)을 scale + rotation으로 역분해(대칭 3×3 Jacobi 고유분해) 후 기록. alpha 0(삭제분)은 제외 → 편집 결과가 그대로 저장됨. (`.npz`는 미구현)
- **스크린샷 (#11)** — 상단 `스크린샷`. `preserveDrawingBuffer` 캔버스를 PNG로 저장.
- **통계 (#12)** — 상단 `통계` 토글. 가우시안 수 / 바운드 크기 / 선택 수 / 메모리.

### ♻️ 리팩토링
- **`src/lib/mathUtils.ts` 신설** — 가우시안 공분산·회전 수학을 한곳에 모음(외부 의존 없는 순수 함수):
  - 정방향: `covarianceFromScaleRotation`, `covarianceUpperTriFromMatrix`
  - 역방향: `covarianceToScaleRotation`, `eigenDecomposeSymmetric3`, `rotationMatrixToQuaternion`
  - `pack.ts`(로드)·`ply.ts`(내보내기)가 공유.
- **`commitEdit` 통합** — move / delete / recolor를 같은 편집 원시(undo 스냅샷 → 복사 → 선택분 변형 → ref 교체)로 통일.
- **버그 수정** — 미완성이던 `DragMoveHandle` 인터페이스 불일치(`onCommit` ↔ `onStart/onMove/onEnd`) 복구.

### ✅ 검증
- `npm run build` (tsc + vite) 통과
- `npm test` — 공분산 라운드트립 셀프체크 (scale+rot → cov → scale+rot → cov, 오차 < 1e-5)

### 사용 메모
- 실제 데이터 로드는 가우시안 stream 서버(host)가 떠 있어야 함.
- 불투명도 0 적용 = alpha 0(삭제와 동일하게 사라짐).
