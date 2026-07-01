# viser-web-direct — 추가 기능 로드맵

서버(viser/Python) 없이 브라우저가 직접 HTTP에서 가우시안을 받아 렌더/편집하는 뷰어.
아래는 앞으로 넣을 만한 기능들. (현재: 로드/스트리밍, 렌더 설정 패널, 박스·더블클릭 선택, 드래그/버튼 이동, undo/reset)

## ✏️ 편집 (Editing)
1. ✅ **그룹 (Groups)** — 선택을 그룹으로 저장 → 재선택 / 숨김·보기 / 색 지정 / 해제. (통째 이동·삭제는 재선택 후 핸들·Delete로)
2. ✅ **삭제 (Delete)** — 선택한 가우시안 제거 (alpha 0; undo 가능, export 시 영구 반영).
3. ✅ **복제 (Duplicate)** — 선택 복사 + 오프셋해서 붙여넣기.
4. ✅ **색 / 불투명도 일괄 변경** — 선택 가우시안의 rgb·opacity를 한 번에 조정.
5. ✅ **회전 / 스케일 편집** — 이동 외에 선택 묶음을 회전·확대 (공분산까지 변환).

## 👁 보기 (Viewing)
6. ✅ **숨기기 / 격리 (Hide / Isolate)** — 선택만 보거나, 선택만 숨기기.
7. ✅ **단면 / 클리핑 평면 (Clipping plane)** — 축 정렬 평면으로 잘라 내부 단면 보기 (⚙에서 축·위치·방향).
8. ✅ **카메라 프리셋 / 북마크** — 정면·위·측면·대각·원점 프리셋 + 현재 시점 저장·복귀(localStorage).
9. ✅ **좌표축 · 측정** — 두 점 클릭으로 실측 거리. (스케일 바는 불필요해서 제거)

## 💾 데이터 (Data)
10. ✅ **내보내기 / 불러오기** — 편집한 가우시안을 `.ply`(표준 3DGS)로 다운로드 + 로컬 `.ply` 파일 로드. (`.npz`는 미구현)
11. ✅ **스크린샷** — 현재 화면을 PNG로 저장.
12. ✅ **통계 패널** — 가우시안 수, 바운드 크기, 선택 수, 메모리.
13. ✅ **검색 / 필터 선택** — 색 유사도(허용오차)·불투명도 범위로 선택 (기존 선택에 추가/선택 평균색 추출). 위치범위·voxel은 미구현.

## ▶️ 재생 (Playback, delta 활용)
14. ✅ **타임라인 스크럽** — delta 프레임을 슬라이더로 앞뒤로 재생 (스캔 누적 과정 보기).
15. ✅ **자동 재생 / 실시간 폴링** — 자동재생(타임라인 ▶·속도) + `라이브` 토글로 새 delta 프레임 3초마다 폴링·append.

## 🔗 공유 / 배포 (Share)
16. ✅ **URL 상태 공유** — host·run·카메라·선택을 URL 쿼리에 담아 링크로 재현.
17. **서버가 dist를 서빙** — 8767 서버에 정적 마운트 → URL 하나로 끝 (CORS·터널 불필요).

## 🚀 성능 / 고급 (Advanced)
18. ✅ **포인트 budget / LOD** — 표시 비율(%)로 솎기 구현. (거리 기반 변형은 여지)
19. **GPU picking** — 클릭 단일 선택 정밀도 향상 (현재는 화면 투영 최근접).
20. ✅ **다중 run 비교** — 두 번째 run(스냅샷)을 같은 씬에 오버레이 + 가로 오프셋으로 나란히 (`도구 ▾ 비교`).

## 🧰 사용성 / 편집 강화 (추가 예정, 쉬운 순)
21. ✅ **Redo + 단축키** — undo/redo 스택, Ctrl+Z / Ctrl+Shift+Z(·Ctrl+Y), Delete 삭제, Esc 선택 해제.
22. ✅ **선택만 내보내기** — 선택 패널에서 선택한 가우시안만 `.ply`로 저장.
23. ✅ **비균등 스케일** — X/Y/Z 개별 스케일 편집 (+균등).
24. ✅ **선택 반전 / 확장** — 반전, 선택 박스 채워 확장.
25. ✅ **숫자 입력 이동/회전** — 이동 step·회전 각도를 숫자로 직접 입력(범위 제한 없음).

## ➕ 이미 구현됨 (로드맵 번호 외 추가분)
- **카메라 조작** — WASD/방향키 플라이(전진=dolly, Shift 가속, Q·E 상하), 관성 제거, 확대 시 회전 속도 자동 조절(콘텐츠 근접도 기준), 원점으로 카메라.
- **실시간 편집 핸들** — 주황 구(이동)·초록 링(회전, 시점축) 드래그가 드래그 중 라이브 반영, 화면 고정 픽셀 크기.
- **씬 전체 회전** — 선택 무관 X/Y/Z 축 기울기 보정.
- **타임라인 재생** — ▶ 재생 / 속도 드래그 / 구간 in–out 지정 → 구간 `.ply` 추출 / on-off 토글.
- **.ply 불러오기** — 로컬 3DGS PLY 로드(프레임 정보 있으면 타임라인 리플레이 복원).
- **기억(localStorage)** — 서버 URL·run·mode·frames, 카메라 북마크 저장/복귀.
- **반응형 UI** — 모바일/태블릿 햄버거 메뉴, 터치 타깃 확대, 패널 뷰포트 맞춤 + 스크롤.
- **성능** — LOD 표시 비율(#18), 크기 변경 시 가우시안 사라지던 버그 수정.

---

## 📋 정식 요구사항(검수 도구 v1) 대비 갭
현재 구현(브라우저-직접 뷰어)은 **3D 맵 렌더·다운샘플(LOD)·편집·오프라인 리뷰·타임라인·delta 라이브 폴링·성능모드·다중 run**을 충족.
아래는 **미구현/부분**. 다수는 **Viewer Server가 해당 데이터를 API로 제공**해야 UI를 붙일 수 있음(현재 서버 API는 runs/summary/snapshot/delta manifest·added 뿐).

### ❌ 미구현 — 서버 API 필요
- **Trajectory 표시** — 카메라/기기 이동 경로 3D 라인. (서버 trajectory API)
- **Camera pose / frustum 표시** — 현재·마지막 pose 위치+방향+시야 frustum. (서버 pose API)
- **Reference point cloud 레이어.**
- **Live 상태 지표** — 마지막 수신시각, image/pose/cloud/processing FPS, sync error·max delta, raw/valid/non-empty cloud count, 새 Gaussian count, GPU/메모리, warning 수. (서버 live-status API)
- **Frame별 timestamp / sync 상태 표시.** (서버 frame-stats API)
- **Run summary 상세 + artifact 목록** — .ply/checkpoint/CSV/NPZ 목록·확인. (서버 API)
- **warning / error 상태 피드.** (서버 API)
- **per-gaussian source_frame_index / source_cloud_stamp_ns 활용.** (데이터 contract)

### ❌ 미구현 — 프론트만으로 가능
- **레이어 on/off 패널** — Gaussian / Trajectory / Camera pose / Point cloud / Grid·Axes 통합 토글 (현재 grid·axes만 분산).
- **구조화된 Error / Empty state** — run 없음 · gaussian 없음 · 필수 field 누락 · 서버 연결 끊김 · 미지원 schema · trajectory 없음 등 명확한 안내 화면 (현재는 상단 status 문자열만).
- **상태 오버레이 확장** — 연결 상태 · 현재 timestamp · trajectory point count 등 (현재 통계 패널은 gaussian 수·bounds·선택·메모리).
- **Timestamp 기준 replay** (현재는 frame index 스크럽).
- **.npz 내보내기** (현재 .ply만) · **거리 기반 LOD** · **GPU picking(#19)**.

### 참고
요구사항은 **viser(Python) 기반**을 기본 검토로 명시. 현재는 viser 렌더러를 포팅한 **브라우저-직접** 방식이라 3D 맵/편집은 충족하나, trajectory·pose·live status는 **서버 API + UI 추가**가 필요. (viser로 갈지, 이 브라우저 뷰어 + 별도 서버 API로 갈지는 9절 미팅 결정사항.)
