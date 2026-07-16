import React from "react";
import { FloatingPanel } from "./FloatingPanel";
import { lsGet, lsSet } from "../lib/storage";
import {
  getBags, startReplay, startTraining, getTraining, stopTraining,
  getLiveStatus, startLive, getLive, stopLive,
  type BagInfo, type TrainingStatus, type LiveSystemStatus, type LiveRunStatus,
} from "../lib/gaussianApi";

/** Default topic set from the API docs — used to prefill the replay/training
 * forms so a bag can be started with one click. */
const DEFAULTS = {
  image_topic: "/camera/image_raw",
  pose_topic: "/aft_mapped_to_init",
  cloud_topic: "/cloud_registered",
  camera_intrinsics: "/tmp/online-3dgs-camera-0424-1920x1080.json",
};

const errText = (e: unknown) => (e as Error)?.message ?? String(e);

/** Viewer-Server control: start a rosbag replay, a training run, or a live
 * capture session — the v2 / v2.1 / live-WIP write APIs. Read-only viewing
 * (timeline / delta accumulation) stays in the main toolbar. */
export function ServerPanel({ host, onClose, onLoadRun, setStatus }: {
  host: string;
  onClose: () => void;
  onLoadRun: (runId: string) => void;
  setStatus: (s: string) => void;
}) {
  const [token, setToken] = React.useState(() => lsGet("serverToken", ""));
  React.useEffect(() => { lsSet("serverToken", token); }, [token]);
  const baseUrl = host || location.origin;

  // ---- replay (v2) ----
  const [bags, setBags] = React.useState<BagInfo[]>([]);
  const [bag, setBag] = React.useState("");
  const [replayRun, setReplayRun] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  async function loadBags() {
    setBusy(true);
    try {
      const b = await getBags(baseUrl);
      setBags(b);
      if (b[0]) { setBag(b[0].bag_id); if (!replayRun) setReplayRun(`replay-${b[0].bag_id.split("/")[0]}`); }
      setStatus(`rosbag 후보 ${b.length}개`);
    } catch (e) { setStatus("bags 오류: " + errText(e)); }
    finally { setBusy(false); }
  }
  async function doReplay() {
    if (!token) { setStatus("run start token이 필요합니다"); return; }
    if (!bag || !replayRun) { setStatus("bag과 run id를 정하세요"); return; }
    setBusy(true);
    try {
      const args = [bag, "--image-topic", DEFAULTS.image_topic, "--pose-topic", DEFAULTS.pose_topic,
        "--cloud-topic", DEFAULTS.cloud_topic, "--camera-intrinsics", DEFAULTS.camera_intrinsics];
      const res = await startReplay(baseUrl, token, { run_id: replayRun, replay_args: args });
      setStatus(`replay 시작됨: ${res.run_id} (${res.status}) — 기록되면 Load`);
      onLoadRun(res.run_id); // switch current run; still-recording runs may 404 until frames land
    } catch (e) { setStatus("replay 오류: " + errText(e)); }
    finally { setBusy(false); }
  }

  // ---- training (v2.1) ----
  const [trainRun, setTrainRun] = React.useState("");
  const [training, setTraining] = React.useState<TrainingStatus | null>(null);
  const [pollTrain, setPollTrain] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (!pollTrain) return;
    let alive = true;
    const tick = async () => {
      try {
        const s = await getTraining(baseUrl, pollTrain);
        if (!alive) return;
        setTraining(s);
        if (["complete", "stopped", "failed"].includes(s.status)) setPollTrain(null);
      } catch { /* 404 while starting — keep polling */ }
    };
    tick();
    const id = setInterval(tick, 2000);
    return () => { alive = false; clearInterval(id); };
  }, [pollTrain, baseUrl]);
  async function doStartTraining() {
    if (!token) { setStatus("token이 필요합니다"); return; }
    if (!trainRun || !bag) { setStatus("run id와 bag을 정하세요 (먼저 bag 불러오기)"); return; }
    setBusy(true);
    try {
      const s = await startTraining(baseUrl, token, { run_id: trainRun, bag_id: bag, ...DEFAULTS });
      setTraining(s); setPollTrain(trainRun);
      setStatus(`학습 시작됨: ${trainRun}`);
    } catch (e) { setStatus("학습 시작 오류: " + errText(e)); }
    finally { setBusy(false); }
  }
  async function doStopTraining() {
    if (!training) return;
    try { await stopTraining(baseUrl, token, training.run_id); setStatus("학습 중단 요청됨"); }
    catch (e) { setStatus("중단 오류: " + errText(e)); }
  }

  // ---- live capture (WIP) ----
  const [live, setLive] = React.useState<LiveSystemStatus | null>(null);
  const [liveRun, setLiveRun] = React.useState("");
  const [liveStatus, setLiveStatus] = React.useState<LiveRunStatus | null>(null);
  const [pollLive, setPollLive] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (!pollLive) return;
    let alive = true;
    const tick = async () => {
      try {
        const s = await getLive(baseUrl, pollLive);
        if (!alive) return;
        setLiveStatus(s);
        if (["completed", "failed", "stopped"].includes(s.status)) setPollLive(null);
      } catch { /* keep polling */ }
    };
    tick();
    const id = setInterval(tick, 2000);
    return () => { alive = false; clearInterval(id); };
  }, [pollLive, baseUrl]);
  async function checkLive() {
    setBusy(true);
    try {
      const s = await getLiveStatus(baseUrl);
      setLive(s);
      if (s.active_run_id) { setLiveRun(s.active_run_id); setPollLive(s.active_run_id); setStatus(`실행 중 세션: ${s.active_run_id}`); }
      else setStatus(s.available ? "촬영 시작 가능" : `시작 불가: ${s.reason ?? "미준비"}`);
    } catch (e) { setStatus("live status 오류: " + errText(e)); }
    finally { setBusy(false); }
  }
  async function doStartLive() {
    if (!token || !live) return;
    if (!liveRun) { setStatus("run id를 정하세요"); return; }
    setBusy(true);
    try {
      const s = await startLive(baseUrl, token, {
        run_id: liveRun,
        capture_device_id: live.capture_devices[0]?.id ?? "",
        workstation_id: live.workstations[0]?.id ?? "",
      });
      setLiveStatus(s); setPollLive(liveRun);
      setStatus(`촬영 시작됨: ${liveRun} (${s.status})`);
    } catch (e) { setStatus("촬영 시작 오류: " + errText(e)); }
    finally { setBusy(false); }
  }
  async function doStopLive() {
    if (!liveStatus) return;
    try { await stopLive(baseUrl, token, liveStatus.run_id); setStatus("촬영 종료 요청됨"); }
    catch (e) { setStatus("종료 오류: " + errText(e)); }
  }

  return (
    <FloatingPanel title="🛰 서버 제어" onClose={onClose} style={{ top: 62, right: 8 }} width="min(260px, calc(100vw - 20px))">
      <label className="row muted">토큰
        <input type="password" className="grow" value={token} placeholder="run start token" onChange={(e) => setToken(e.target.value)} />
      </label>
      <div className="muted" style={{ fontSize: 11 }}>Base: {baseUrl}</div>

      <hr className="divider" />
      <div className="muted">▶ Replay 시작 (v2)</div>
      <div className="row">
        <button className="grow" onClick={loadBags} disabled={busy}>bag 불러오기</button>
        {bags.length > 0 && <span className="num muted">{bags.length}</span>}
      </div>
      {bags.length > 0 && (
        <select value={bag} onChange={(e) => setBag(e.target.value)}>
          {bags.map((b) => <option key={b.bag_id} value={b.bag_id}>{b.bag_id}</option>)}
        </select>
      )}
      <label className="row muted">run id
        <input className="grow" value={replayRun} placeholder="새 run 이름" onChange={(e) => setReplayRun(e.target.value)} />
      </label>
      <button onClick={doReplay} disabled={busy || !token || !bag}>Replay 시작</button>

      <hr className="divider" />
      <div className="muted">🎓 학습 (v2.1)</div>
      <label className="row muted">run id
        <input className="grow" value={trainRun} placeholder="새 학습 run 이름" onChange={(e) => setTrainRun(e.target.value)} />
      </label>
      <div className="row">
        <button className="grow" onClick={doStartTraining} disabled={busy || !token || !bag}>학습 시작</button>
        <button className="grow danger" onClick={doStopTraining} disabled={!training || !pollTrain}>중단</button>
      </div>
      {training && (
        <div className="muted" style={{ fontSize: 12 }}>
          {training.run_id}: <b>{training.status}</b>{training.pid_running === false ? " (프로세스 종료)" : ""}
        </div>
      )}

      <hr className="divider" />
      <div className="muted">🔴 실시간 촬영 (WIP)</div>
      <button onClick={checkLive} disabled={busy}>상태 확인</button>
      {live && (
        <>
          <div className="muted" style={{ fontSize: 12 }}>
            {live.available ? "✅ 시작 가능" : `⛔ ${live.reason ?? "미준비"}`}
            {live.capture_devices[0] && ` · ${live.capture_devices[0].label}`}
          </div>
          <label className="row muted">run id
            <input className="grow" value={liveRun} placeholder="capture-001" onChange={(e) => setLiveRun(e.target.value)} />
          </label>
          <div className="row">
            <button className="grow" onClick={doStartLive} disabled={busy || !token || !live.available || !!live.active_run_id}>스캔 시작</button>
            <button className="grow danger" onClick={doStopLive} disabled={!liveStatus || !pollLive}>종료</button>
          </div>
        </>
      )}
      {liveStatus && (
        <div className="muted" style={{ fontSize: 12 }}>
          {liveStatus.run_id}: <b>{liveStatus.status}</b>{liveStatus.phase ? ` · ${liveStatus.phase}` : ""}
          {liveStatus.error ? ` · ⚠ ${liveStatus.error}` : ""}
        </div>
      )}
    </FloatingPanel>
  );
}
