/** Worker for sorting splats.
 */

import MakeSorterModuleFactory from "./WasmSorter/Sorter.mjs";
// Import WASM as base64 URL for inlining - avoids import.meta.url issues with blob URLs.
import SorterWasmUrl from "./WasmSorter/Sorter.wasm?url";

export type SorterWorkerIncoming =
  | {
      setBuffer: Uint32Array;
      setGroupIndices: Uint32Array;
    }
  | {
      updateBuffer: Uint32Array;
      updateGroupIndices: Uint32Array;
    }
  | {
      setTz_camera_groups: Float32Array;
    }
  | {
      // Consumed index buffer sent back from the main thread for reuse, so
      // steady-state sorting allocates nothing (no per-sort .slice() copy).
      recycleBuffer: Uint32Array;
    }
  | { close: true };

{
  let sorter: any = null;
  let Tz_camera_groups: Float32Array | null = null;
  let sortRunning = false;
  // Pool of index buffers returned by the main thread after it copied them
  // into the geometry attribute. Transferred back and forth, so at steady
  // state the worker ping-pongs between two buffers instead of allocating
  // numGaussians * 4 bytes on every sort.
  const recycledBuffers: Uint32Array[] = [];
  const throttledSort = () => {
    if (sorter === null || Tz_camera_groups === null) {
      setTimeout(throttledSort, 1);
      return;
    }
    if (sortRunning) return;

    sortRunning = true;
    const lastView = Tz_camera_groups;

    // Important: we copy the output (into a recycled buffer when one fits) so
    // we can transfer it to the main thread. Compared to relying on
    // postMessage for copying, this reduces backlog artifacts.
    const result = sorter.sort(Tz_camera_groups) as Uint32Array;
    let sortedIndices = recycledBuffers.pop();
    if (sortedIndices === undefined || sortedIndices.length !== result.length) {
      sortedIndices = new Uint32Array(result.length);
    }
    sortedIndices.set(result);

    // @ts-ignore
    self.postMessage({ sortedIndices: sortedIndices }, [sortedIndices.buffer]);

    setTimeout(() => {
      sortRunning = false;
      if (Tz_camera_groups === null) return;
      // Each setTz message carries a fresh Float32Array, so a reference check
      // is enough to detect "camera moved while we were sorting" (the main
      // thread already thresholds what it sends; no element-wise scan needed).
      if (lastView !== Tz_camera_groups) {
        throttledSort();
      }
    }, 0);
  };

  // Fetch WASM binary and pass to Emscripten module to avoid import.meta.url issues.
  const SorterModulePromise = fetch(SorterWasmUrl)
    .then((response) => response.arrayBuffer())
    .then((wasmBinary) => MakeSorterModuleFactory({ wasmBinary }));

  self.onmessage = async (e) => {
    const data = e.data as SorterWorkerIncoming;
    if ("setBuffer" in data) {
      // Instantiate sorter with buffers populated.
      sorter = new (await SorterModulePromise).Sorter(
        data.setBuffer,
        data.setGroupIndices,
      );
    } else if ("updateBuffer" in data) {
      // Update existing sorter with new buffer data.
      if (sorter !== null) {
        sorter.setBuffer(data.updateBuffer, data.updateGroupIndices);
        // Trigger immediate sort if we have camera data.
        if (Tz_camera_groups !== null) {
          throttledSort();
        }
      }
    } else if ("setTz_camera_groups" in data) {
      // Update object transforms.
      Tz_camera_groups = data.setTz_camera_groups;
      throttledSort();
    } else if ("recycleBuffer" in data) {
      // Keep a small pool; stale sizes are filtered at reuse time.
      if (recycledBuffers.length < 2) recycledBuffers.push(data.recycleBuffer);
    } else if ("close" in data) {
      // Done!
      self.close();
    }
  };
}
