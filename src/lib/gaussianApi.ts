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
