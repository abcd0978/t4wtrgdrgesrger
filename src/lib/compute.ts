/** Client for the compute worker (see computeWorker.ts). Each call transfers a
 * COPY of the buffer so the caller's array is never detached. If the worker
 * can't be created or errors, callers fall back to the synchronous kernel — so
 * behaviour is identical, the worker is purely a responsiveness optimization.
 *
 * Worth the worker only for large scenes: below WORKER_MIN gaussians the copy +
 * round-trip costs more than just scanning on the main thread. */
import { type Bounds } from "./bounds";
import { detectFloaters, diffHeatmapColors } from "./gaussianOps";

export const WORKER_MIN = 400_000; // gaussians

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

function getWorker(): Worker | null {
  if (worker) return worker;
  if (typeof Worker === "undefined") return null;
  try {
    worker = new Worker(new URL("./computeWorker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent<{ id: number; result?: unknown; error?: string }>) => {
      const p = pending.get(e.data.id);
      if (!p) return;
      pending.delete(e.data.id);
      if (e.data.error) p.reject(new Error(e.data.error));
      else p.resolve(e.data.result);
    };
    worker.onerror = () => {
      // A worker-level failure rejects everything in flight; callers fall back.
      for (const p of pending.values()) p.reject(new Error("compute worker error"));
      pending.clear();
      worker = null;
    };
  } catch {
    worker = null;
  }
  return worker;
}

function post<T>(msg: Record<string, unknown>, transfer: Transferable[]): Promise<T> {
  const w = getWorker();
  if (!w) return Promise.reject(new Error("no worker"));
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    w.postMessage({ ...msg, id }, transfer);
  });
}

/** Floater indices to delete. Worker for big scenes, else synchronous. */
export async function computeFloaters(buffer: Uint32Array, bounds: Bounds): Promise<number[]> {
  if (buffer.length / 8 < WORKER_MIN) return detectFloaters(buffer, bounds);
  try {
    const copy = buffer.slice();
    return await post<number[]>({ op: "floaters", buffer: copy, bounds }, [copy.buffer]);
  } catch {
    return detectFloaters(buffer, bounds); // fallback: identical result
  }
}

/** Recoloured (diff-heatmap) buffer. Worker for big scenes, else synchronous. */
export async function computeHeatmap(buffer: Uint32Array, overlay: Uint32Array, bounds: Bounds): Promise<Uint32Array> {
  if (buffer.length / 8 < WORKER_MIN) return diffHeatmapColors(buffer, overlay, bounds);
  try {
    const bufCopy = buffer.slice();
    const ovCopy = overlay.slice();
    return await post<Uint32Array>({ op: "heatmap", buffer: bufCopy, overlay: ovCopy, bounds }, [bufCopy.buffer, ovCopy.buffer]);
  } catch {
    return diffHeatmapColors(buffer, overlay, bounds); // fallback: identical result
  }
}
