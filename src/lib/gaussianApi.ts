/** HTTP client for the gaussian-stream server (port of example api_client.py).
 * The browser fetches directly — no viser/Python in between. */

export interface DeltaFrame {
  frame_index: number;
  artifact: string;
  new_gaussian_count: number;
  cumulative_gaussian_count: number;
}
export interface DeltaManifest {
  delta_type: string;
  frame_count: number;
  frames: DeltaFrame[];
}

function join(host: string, path: string): string {
  return host.replace(/\/+$/, "") + "/" + path;
}

export async function getDeltaManifest(host: string, runId: string): Promise<DeltaManifest> {
  const url = join(host, `api/runs/${encodeURIComponent(runId)}/gaussians/deltas/manifest`);
  const r = await fetch(url, { headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error(`manifest ${r.status} @ ${url}`);
  return r.json();
}

export async function getAddedNpz(host: string, runId: string, frameIndex: number): Promise<ArrayBuffer> {
  const url = join(host, `api/runs/${encodeURIComponent(runId)}/gaussians/deltas/${frameIndex}/added`);
  const r = await fetch(url, { headers: { Accept: "application/octet-stream" } });
  if (!r.ok) throw new Error(`delta ${frameIndex}: ${r.status}`);
  return r.arrayBuffer();
}

/** Full snapshot: every Gaussian in one npz (works for runs without deltas). */
export async function getSnapshot(host: string, runId: string): Promise<ArrayBuffer> {
  const url = join(host, `api/runs/${encodeURIComponent(runId)}/gaussians/snapshot`);
  const r = await fetch(url, { headers: { Accept: "application/octet-stream" } });
  if (!r.ok) throw new Error(`snapshot ${r.status}`);
  return r.arrayBuffer();
}

export interface RunInfo {
  runId: string;
  gaussians: number;
  frames: number;
}

/** List runs for the dropdown. */
export async function getRuns(host: string): Promise<RunInfo[]> {
  const url = join(host, "api/runs");
  const r = await fetch(url, { headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error(`runs ${r.status}`);
  const d = await r.json();
  return (d.runs ?? []).map((x: Record<string, any>) => ({
    runId: x.run_id,
    gaussians: x.summary?.total_gaussian_count ?? 0,
    frames: x.summary?.processed_frame_count ?? 0,
  }));
}

// ---------------------------------------------------------------------------
// v1 timeline — slider range + per-frame elapsed time + cumulative counts.
// ---------------------------------------------------------------------------
export interface TimelineFrame {
  frame_index: number;
  elapsed_sec: number;
  cumulative_gaussian_count: number;
}
export interface Timeline {
  run_id?: string;
  frame_count?: number;
  frames: TimelineFrame[];
}

export async function getTimeline(host: string, runId: string): Promise<Timeline> {
  const url = join(host, `api/runs/${encodeURIComponent(runId)}/timeline`);
  const r = await fetch(url, { headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error(`timeline ${r.status} @ ${url}`);
  const d = await r.json();
  return { run_id: d.run_id, frame_count: d.frame_count, frames: d.frames ?? [] };
}

// ---------------------------------------------------------------------------
// Shared helpers for the state-changing (Bearer-token) APIs.
// ---------------------------------------------------------------------------
const authHeaders = (token: string, json = false): Record<string, string> => ({
  Authorization: `Bearer ${token}`,
  Accept: "application/json",
  ...(json ? { "Content-Type": "application/json" } : {}),
});

/** Throw a message that carries the HTTP status (callers branch on 403/404/409). */
async function ensureOk(r: Response, label: string): Promise<Response> {
  if (r.ok) return r;
  let detail = "";
  try { detail = (await r.json())?.detail ?? (await r.text()); } catch { /* ignore */ }
  const err = new Error(`${label} ${r.status}${detail ? `: ${detail}` : ""}`) as Error & { status: number };
  err.status = r.status;
  throw err;
}

// ---------------------------------------------------------------------------
// v2 — rosbag candidates + replay start.
// ---------------------------------------------------------------------------
export interface BagInfo { bag_id: string }

export async function getBags(host: string): Promise<BagInfo[]> {
  const url = join(host, "api/bags");
  const r = await ensureOk(await fetch(url, { headers: { Accept: "application/json" } }), "bags");
  const d = await r.json();
  return (d.bags ?? []).map((x: Record<string, any>) => ({ bag_id: x.bag_id }));
}

export interface StartRunResult {
  schema_version?: number;
  status: string; // "started"
  run_id: string;
  pid?: number;
  output_dir?: string;
  log_artifact?: string;
}

/** POST /api/runs — start a rosbag replay. `replay_args[0]` is the bag path/id;
 * the server injects --run-output-dir / --live-delta-output. Returns 202. */
export async function startReplay(host: string, token: string, body: { run_id: string; replay_args: string[] }): Promise<StartRunResult> {
  const url = join(host, "api/runs");
  const r = await ensureOk(await fetch(url, { method: "POST", headers: authHeaders(token, true), body: JSON.stringify(body) }), "start replay");
  return r.json();
}

// ---------------------------------------------------------------------------
// v2.1 — training runs (start / status / stop).
// ---------------------------------------------------------------------------
export interface TrainingStartBody {
  run_id: string;
  bag_id: string;
  image_topic: string;
  pose_topic: string;
  cloud_topic: string;
  camera_intrinsics: string;
  fastlivo_avia_yaml?: string;
  fastlivo_state_frame?: string;
  camera_parent_frame?: string;
  camera_child_frame?: string;
  image_time_offset_sec?: number;
  max_sync_dt_ms?: number;
}
export type TrainingStatusValue = "created" | "running" | "complete" | "stopping" | "stopped" | "failed";
export interface TrainingStatus {
  run_id: string;
  status: TrainingStatusValue;
  pid?: number;
  pid_running?: boolean;
  output_dir?: string;
  summary?: unknown;
}

export async function startTraining(host: string, token: string, body: TrainingStartBody): Promise<TrainingStatus> {
  const url = join(host, "api/training-runs");
  const r = await ensureOk(await fetch(url, { method: "POST", headers: authHeaders(token, true), body: JSON.stringify(body) }), "start training");
  return r.json();
}

export async function getTraining(host: string, runId: string): Promise<TrainingStatus> {
  const url = join(host, `api/training-runs/${encodeURIComponent(runId)}`);
  const r = await ensureOk(await fetch(url, { headers: { Accept: "application/json" } }), "training status");
  return r.json();
}

export async function stopTraining(host: string, token: string, runId: string): Promise<TrainingStatus> {
  const url = join(host, `api/training-runs/${encodeURIComponent(runId)}`);
  const r = await ensureOk(await fetch(url, { method: "DELETE", headers: authHeaders(token) }), "stop training");
  return r.json();
}

// ---------------------------------------------------------------------------
// Live capture (WIP) — readiness + live session start / status / stop.
// ---------------------------------------------------------------------------
export interface LiveDevice { id: string; label: string }
export interface LiveSystemStatus {
  available: boolean;
  active_run_id: string | null;
  capture_devices: LiveDevice[];
  workstations: LiveDevice[];
  control_channel?: string;
  discovery_server?: string;
  jetson_service?: string;
  runtime_command?: string;
  paths?: Record<string, string>;
  reason?: string | null;
}
export interface LiveRunStatus {
  schema_version?: number;
  run_id: string;
  capture_device_id?: string;
  workstation_id?: string;
  status: string; // starting | running | stopping | completed | failed | stopped
  phase?: string;
  jetson_service?: string;
  control_channel?: string;
  topics?: Record<string, string>;
  bag_path?: string;
  run_output_path?: string;
  processes?: Record<string, string>;
  error?: string | null;
}

export async function getLiveStatus(host: string): Promise<LiveSystemStatus> {
  const url = join(host, "api/live-system/status");
  const r = await ensureOk(await fetch(url, { headers: { Accept: "application/json" } }), "live status");
  return r.json();
}

export async function startLive(host: string, token: string, body: { run_id: string; capture_device_id: string; workstation_id: string }): Promise<LiveRunStatus> {
  const url = join(host, "api/live-training-runs");
  const r = await ensureOk(await fetch(url, { method: "POST", headers: authHeaders(token, true), body: JSON.stringify(body) }), "start live");
  return r.json();
}

export async function getLive(host: string, runId: string): Promise<LiveRunStatus> {
  const url = join(host, `api/live-training-runs/${encodeURIComponent(runId)}`);
  const r = await ensureOk(await fetch(url, { headers: { Accept: "application/json" } }), "live run");
  return r.json();
}

export async function stopLive(host: string, token: string, runId: string): Promise<LiveRunStatus> {
  const url = join(host, `api/live-training-runs/${encodeURIComponent(runId)}`);
  const r = await ensureOk(await fetch(url, { method: "DELETE", headers: authHeaders(token) }), "stop live");
  return r.json();
}
