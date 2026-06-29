/// <reference types="vite/client" />

// Emscripten sorter module (plain .mjs, no shipped types).
declare module "*/Sorter.mjs" {
  const factory: (opts: { wasmBinary: ArrayBuffer }) => Promise<{
    Sorter: new (buffer: Uint32Array, groupIndices: Uint32Array) => {
      setBuffer(buffer: Uint32Array, groupIndices: Uint32Array): void;
      sort(Tz_camera_groups: Float32Array): Uint32Array;
      delete(): void;
    };
  }>;
  export default factory;
}
