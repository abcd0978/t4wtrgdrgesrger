/** Worker for sorting splats.
 */

import MakeSorterModuleFactory from "./WasmSorter/Sorter.mjs";
// Import WASM as base64 URL for inlining - avoids import.meta.url issues with blob URLs.
import SorterWasmUrl from "./WasmSorter/Sorter.wasm?url";

export type SorterWorkerIncoming =
  | {
      setBuffer: Uint32Array;
      setGroupIndices: Uint32Array;
      forceJsSort?: boolean; // diagnostic: skip WASM (?jssort URL flag)
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

/** Pure-JS fallback with the same interface as the WASM Sorter: a 16-bit
 * counting sort over camera-space Z, ascending (farthest first — identical
 * ordering to sorter.cpp). The WASM module is built with -msimd128, which
 * iOS Safari < 16.4 (and some older browsers) cannot instantiate; without a
 * fallback those devices never sort and render an x-ray mess. ~2-3x slower
 * than WASM but the same big-O; antimatter15 sorts in plain JS too. */
class JsSorter {
  private f32!: Float32Array;
  private groups!: Uint32Array;
  private n = 0;
  private depths!: Float32Array;
  private bins!: Uint32Array;
  private out!: Uint32Array;
  private counts = new Uint32Array(65536);
  private starts = new Uint32Array(65536);
  constructor(buffer: Uint32Array, groupIndices: Uint32Array) {
    this.setBuffer(buffer, groupIndices);
  }
  setBuffer(buffer: Uint32Array, groupIndices: Uint32Array) {
    this.f32 = new Float32Array(buffer.buffer, buffer.byteOffset, buffer.length);
    this.groups = groupIndices;
    const n = buffer.length / 8;
    if (n !== this.n) {
      this.n = n;
      this.depths = new Float32Array(n);
      this.bins = new Uint32Array(n);
      this.out = new Uint32Array(n);
    }
  }
  sort(Tz: Float32Array): Uint32Array {
    const { f32, groups, n, depths, bins, out, counts, starts } = this;
    let mn = Infinity, mx = -Infinity;
    for (let i = 0; i < n; i++) {
      const b = i * 8, g = groups[i] * 4;
      const z = Tz[g] * f32[b] + Tz[g + 1] * f32[b + 1] + Tz[g + 2] * f32[b + 2] + Tz[g + 3];
      depths[i] = z;
      if (z < mn) mn = z;
      if (z > mx) mx = z;
    }
    counts.fill(0);
    const inv = 65535 / (mx - mn + 1e-9);
    for (let i = 0; i < n; i++) {
      const bin = ((depths[i] - mn) * inv) | 0;
      bins[i] = bin;
      counts[bin]++;
    }
    starts[0] = 0;
    for (let i = 1; i < 65536; i++) starts[i] = starts[i - 1] + counts[i - 1];
    for (let i = 0; i < n; i++) out[starts[bins[i]]++] = i;
    return out;
  }
  delete() { /* interface parity with the embind object */ }
}

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
      // Instantiate sorter with buffers populated; fall back to the JS
      // implementation when the SIMD WASM module can't load on this device.
      if (data.forceJsSort) {
        sorter = new JsSorter(data.setBuffer, data.setGroupIndices);
      } else {
        try {
          sorter = new (await SorterModulePromise).Sorter(
            data.setBuffer,
            data.setGroupIndices,
          );
        } catch (err) {
          console.warn("[splat] WASM sorter unavailable; using JS fallback:", err);
          sorter = new JsSorter(data.setBuffer, data.setGroupIndices);
        }
      }
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
