/** Off-main-thread runner for the heavy whole-buffer scans (floater detection,
 * diff heatmap). It runs the exact same pure kernels as the synchronous path in
 * gaussianOps, so results are identical by construction — the worker only moves
 * the O(N) loop off the UI thread so big scenes don't freeze while it runs.
 *
 * Protocol: { id, op, buffer, ... } in → { id, result | error } out. The caller
 * transfers a COPY of the buffer (so its own array is never neutered); buffer
 * results are transferred back. */
import { type Bounds } from "./bounds";
import { detectFloaters, diffHeatmapColors } from "./gaussianOps";

type Req =
  | { id: number; op: "floaters"; buffer: Uint32Array; bounds: Bounds }
  | { id: number; op: "heatmap"; buffer: Uint32Array; overlay: Uint32Array; bounds: Bounds };

self.onmessage = (e: MessageEvent<Req>) => {
  const msg = e.data;
  try {
    if (msg.op === "floaters") {
      const del = detectFloaters(msg.buffer, msg.bounds);
      self.postMessage({ id: msg.id, result: del });
    } else if (msg.op === "heatmap") {
      const nb = diffHeatmapColors(msg.buffer, msg.overlay, msg.bounds);
      (self as unknown as Worker).postMessage({ id: msg.id, result: nb }, [nb.buffer]);
    }
  } catch (err) {
    self.postMessage({ id: msg.id, error: (err as Error).message });
  }
};
