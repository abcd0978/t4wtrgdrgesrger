# Viewer Server API 명세 (v0 → v2.1 + Live WIP)

**서버(버전별 테스트 포트)**: v0/v1 `:8765` · v1.5 `:8766` · v2 + bags `:8767` · v2.1 `:8768` · Live=기존 서버
**Token**(쓰기 API 전용): `Authorization: Bearer viewer-v2-dev-20260626-9b6f2e1c4d7a8f03`
**예시 Run ID**: `online-3dgs-desk-20260624-spnet-gated-full-r2-deltas`
조회(GET) API는 토큰 불필요. `{run_id}` / `{frame_index}`는 path 파라미터.

| Method · Path | 요청타입 (헤더 / 바디) | 성공 시 반환 | 실패 시 반환 | 비고 (status 의미) |
|---|---|---|---|---|
| `GET /api/runs` | — | `200` `{ runs: [{ run_id, summary:{ total_gaussian_count, processed_frame_count } }] }` | — | 저장된 run output 목록 (v0) |
| `GET /api/runs/{run_id}/timeline` | path: `run_id` | `200` `{ frame_count, frames: [{ frame_index, elapsed_sec, cumulative_gaussian_count }] }` | `404` | slider 범위 + 시간 + 누적 수. `404`=아직 미기록/run 없음 → 재조회 (v1) |
| `GET /api/runs/{run_id}/gaussians/deltas/manifest` | path: `run_id` | `200` `{ delta_type, frame_count, frames: [{ frame_index, new_gaussian_count, cumulative_gaussian_count, artifact }] }` | `404` | delta가 **있는 frame만** 나열 (v1) |
| `GET /api/runs/{run_id}/gaussians/deltas/{frame_index}/added` | path: `run_id`, `frame_index` | `200` **NPZ binary**: `mean_xyz[N,3]` `scale_xyz[N,3]` `rotation_xyzw[N,4]` `color_rgb[N,3]` `opacity[N]` | `404` | 그 frame에 새로 추가된 gaussian. **반드시 `manifest.frames`에 있는 frame만** 요청 (v1) |
| `GET /api/runs/{run_id}/gaussians/snapshot` | path: `run_id` | `200` **NPZ binary** (added와 동일 키) | `404` | 누적 아님 — 최종 전체 map 한 번에 (v1) |
| `GET /api/bags` | — | `200` `{ bags: [{ bag_id }] }` | — | replay용 rosbag 후보. `path`는 미포함, `bag_id`만 사용 (v2) |
| `POST /api/runs` | **Bearer** · `{ run_id, replay_args: [bag_path/id, "--image-topic", …, "--pose-topic", …, "--cloud-topic", …, "--camera-intrinsics", …] }` | `202` `{ schema_version, status:"started", run_id, pid, output_dir, log_artifact }` | `400` / `403` | rosbag replay 시작. `--run-output-dir`/`--live-delta-output`는 서버가 주입. **`400`**=값오류·`run_id` 중복·시작 실패, **`403`**=토큰 없음/틀림 (v2) |
| `POST /api/training-runs` | **Bearer** · `{ run_id, bag_id, image_topic, pose_topic, cloud_topic, camera_intrinsics, fastlivo_avia_yaml, fastlivo_state_frame, camera_parent_frame, camera_child_frame, image_time_offset_sec, max_sync_dt_ms }` | `200` `{ run_id, status, pid, pid_running, output_dir, summary }` | `400` / `403` | 학습 시작. 학습 옵션은 서버 프로파일 사용. `run_id` 중복 시 거절 (v2.1) |
| `GET /api/training-runs/{run_id}` | path: `run_id` | `200` `{ run_id, status, pid, pid_running, output_dir, summary }` | `404` | `status`: `created`·`running`·`complete`·`stopping`·`stopped`·`failed`. 완료 시 `summary`=`mapper_summary.json` (v2.1) |
| `DELETE /api/training-runs/{run_id}` | **Bearer** · path: `run_id` | `200` `{ run_id, status:"stopping", … }` | `403` / `404` | 학습 프로세스에 **SIGTERM** (파일 유지). 일시정지 없음 (v2.1) |
| `GET /api/live-system/status` | — | `200` `{ available, active_run_id, capture_devices:[{id,label}], workstations:[{id,label}], control_channel, discovery_server, jetson_service, runtime_command, paths:{…}, reason }` | — | 촬영 readiness. `available:true`→시작 가능, `active_run_id`≠null→기존 세션. `jetson_service:"inactive"`=정상 대기 (Live) |
| `POST /api/live-training-runs` | **Bearer** · `{ run_id, capture_device_id, workstation_id }` | `200` `{ schema_version, run_id, status:"starting", phase:"checking_readiness", created_at, capture_device_id, workstation_id }` | `403` / `409` | 실시간 촬영/학습 시작. **`409`**=이미 active session 존재(동시 1개). `run_id`는 `A-Za-z0-9._-` (Live) |
| `GET /api/live-training-runs/{run_id}` | path: `run_id` | `200` `{ run_id, status, phase, jetson_service, control_channel, topics:{"/re/img":…}, processes:{bag_recorder,runtime_mapper}, bag_path, run_output_path, error }` | `404` | polling용. `status`: `starting`·`running`·`stopping`·`completed`·`failed`·`stopped`. `phase`: `checking_readiness`→`starting_jetson`→`waiting_topics`→`starting_recording`→`starting_training`→`training`→`stopping_*`→`completed`/`failed`/`orphaned` (Live) |
| `DELETE /api/live-training-runs/{run_id}` | **Bearer** · path: `run_id` | `200` `{ run_id, status:"stopping", … }` | `403` / `404` | 종료 순서: runtime `SIGINT`→recorder `SIGINT`→`metadata.yaml` flush→Jetson service stop. **반복 호출 안전(idempotent)** (Live) |

**status 코드 요약** — `202` replay 수락(started) · `400` 값오류/`run_id` 중복/시작 실패 · `403` 토큰 없음·틀림 · `404` 미기록/artifact 없음/run 없음(진행 중이면 재조회) · `409` 이미 active live session

**누적 표시 규칙 (v1)**: slider가 frame N → `manifest.frames` 중 `frame_index ≤ N`인 `added` NPZ를 모두 받아 이어붙여 하나의 splat으로 렌더. delta 없는 frame은 이전 상태 유지.

**Out of Scope**: WebSocket/SSE streaming · manifest/timeline 폴링 내장 · 일시정지(중단만) · optimization update history · bag 후보 replay 중단 버튼 · mapper 상태 지속 추적
