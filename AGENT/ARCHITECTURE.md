# viser-web-direct — Architecture

A browser-only 3D Gaussian Splatting viewer/editor. React 19 + Three.js +
`@react-three/fiber`, with a Web Worker doing depth sorting (WASM SIMD, JS
fallback). No server is required: it loads local files (`.ply` / `.splat` /
`.spz`) and CDN demo scenes, and can also stream from a viser server.

This document is the map. Read it before making a structural change so you know
which layer a change belongs in and what invariants it must not break.

---

## 1. The packed gaussian buffer (the one data structure that matters)

Everything centres on a single flat typed array. A scene of *N* gaussians is a
`Uint32Array` of length `N * 8` — **32 bytes per gaussian**:

| bytes | field   | type      | meaning |
|-------|---------|-----------|---------|
| 0–11  | xyz     | 3× f32    | position (viewer z-up space) |
| 12–15 | group   | u32       | render group id (0 = base; used by wipe/compare) |
| 16–27 | cov     | 6× f16    | upper-triangular 3×3 covariance |
| 28–31 | rgba    | 4× u8     | colour + opacity |

Key invariants:

- **`alpha == 0` is the "empty / deleted" sentinel.** Render, picking, bounds,
  export, and stats all skip alpha-0 slots. All destructive edits (delete,
  crop, floater-clean, keep-only) are just alpha-0 writes — which is why they
  are all reversible via the undo stack and only "bake in" on export.
- **Edits are copy-on-write.** The freshly loaded array is never mutated in
  place; `originalBuffer` keeps the load-time reference so `reset()` is free and
  loads don't pay a defensive `.slice()`.
- **Same length ⇒ in-place GPU update.** When an edit keeps the gaussian count
  constant, the renderer updates the data texture without a remount or a bounds
  rescan. Count-changing edits (`duplicate`, `merge`) bump `splatKey` to remount.

An **optional degree-1 SH side buffer** (`sh1`, 8 u32 per gaussian) rides
alongside `buffer`, index-aligned, for `.ply` / `.spz` scenes that carry
view-dependent colour. It is dropped whenever indices can't be tracked.

Helpers for this layout live in `src/lib/gaussianEdit.ts` (`viewOf`,
`readCov6`/`writeCov6`, `hexToRgb`, `avgColorHex`) and `src/lib/bounds.ts`
(`computeBounds`, `center`, `radius`, `selCenter`).

---

## 2. Layering

```
┌─────────────────────────────────────────────────────────────┐
│ App.tsx  — orchestration: React state, effects, JSX, wiring  │
│   owns buffer/selection/settings/camera-refs/undo stacks,    │
│   composes the toolbar + floating panels + the R3F <Canvas>  │
└───────────────┬───────────────────────────────┬─────────────┘
                │ calls pure kernels             │ renders
                ▼                                ▼
┌───────────────────────────────┐   ┌──────────────────────────┐
│ lib/  — pure logic, no React  │   │ components/, splat/ — R3F │
│  gaussianOps  buffer/sel math │   │  SceneObjects  camera,    │
│  ply/splat/spz/pack  parsers  │   │    gestures, gizmos,      │
│  npz/npzWrite  export         │   │    pickers, overlays      │
│  bounds/mathUtils  geometry   │   │  GaussianSplats  renderer │
│  urlState  share links        │   │  SplatSortWorker  sorting │
│  storage/scenes/camPose  misc │   │  SettingsPanel/EditPanels │
└───────────────────────────────┘   └──────────────────────────┘
```

The refactor that produced this doc pulled the **pure logic** out of `App.tsx`
so it is unit-testable and the component is orchestration-only. The rule going
forward:

- **No React / DOM in `lib/`.** A `lib/` function takes plain data (a buffer,
  params) and returns plain data (a new buffer, a `Set`, a value). If you need
  `setState`, a ref, or a toast, that belongs in `App.tsx`.
- **`App.tsx` methods stay thin.** They do the stateful dance — snapshot for
  undo, call the kernel, `setBuffer`, `setStatus` — and nothing heavy inline.
  A new buffer/selection operation should be a new function in
  `lib/gaussianOps.ts` with a test, wrapped by a short App method.

---

## 3. Module map

### `src/lib/` (pure)

| file | responsibility |
|------|----------------|
| `gaussianOps.ts` | **The compute kernel.** `buildDisplayBuffer` (timeline truncation + hide/isolate + group-hide + selection highlight), `subsampleForLod`/`subsampleShForLod`, whole-buffer transforms (`rotateSceneBuffer`, `cropOutside`, `keepOnly`, `duplicateSelection`, `deleteIndices`), `detectFloaters`, selection predicates (`invertSelection`, `growSelection`, `colorFilterSelection`, `opacityFilterSelection`, `selectByPosition`), `frameArray`, `computeSceneStats`, `diffHeatmapColors`. |
| `bounds.ts` | AABB + `center`/`radius`/`selCenter`. |
| `mathUtils.ts` | covariance ↔ scale/rotation, `rotateCovariance`, `scaleCovariance`, `rotationAboutAxis`. |
| `gaussianEdit.ts` | low-level byte accessors for the packed layout. |
| `ply.ts` | `.ply` parse/write, incl. degree-1 SH extraction. |
| `splatFile.ts` | `.splat` (antimatter15) parse; streaming `fetchSplatToPacked`; `subsamplePacked`. |
| `spz.ts` | Niantic `.spz` (gzip) decode → packed + SH1. **β** (field order unverified against a real capture). |
| `pack.ts` / `npz.ts` / `npzWrite.ts` | viser-server npz snapshot/delta unpack + npz export. |
| `gaussianApi.ts` | viser-server REST calls (`getRuns`, `getSnapshot`, delta manifest/frames). |
| `urlState.ts` | full-state share links: encode/decode the single `?z=` base64url param (+ legacy params). |
| `storage.ts` | `localStorage` under the `vwd:` prefix — `lsGet`/`lsSet`/`lsNum`/`lsBool`/`lsJson`, all error-swallowing. |
| `scenes.ts` | CDN demo catalogue, first-visit `DEFAULT_TEST_VIEW`, `Recent` type. |
| `camPose.ts` | camera-pose clipboard `parse`/`format`. |

### `src/splat/` (rendering + sorting)

| file | responsibility |
|------|----------------|
| `GaussianSplats.tsx` | R3F renderer. `SplatRenderContext` provides the shared store; `SplatObject` uploads a buffer, spins up the sort worker, syncs uniforms (crop, wipe, SH, distance-LOD), and updates in place when the buffer length is unchanged. |
| `GaussianSplatsHelpers.ts` | GLSL (highp — the Apple-GPU x-ray fix), covariance→screen-quad math, per-gaussian discard for crop/wipe/distance-LOD, mesh construction, the render store. |
| `SplatSortWorker.ts` | off-main-thread depth sort. `JsSorter` (16-bit counting sort, far→near) is the fallback when the WASM SIMD sorter is unavailable (e.g. some WebKit). `?jssort` forces JS. Buffers ping-pong via transfer to avoid GC churn. |
| `WasmSorter/` | the `-msimd128` WASM sorter + glue. |

### `src/components/` (UI + scene graph)

- `SceneObjects.tsx` — the non-splat R3F pieces: `FitCamera`/`ApplyCamera`/
  `CameraBridge` (imperative `CameraApi`), `GestureControls` (custom
  trackball-rotate + fly-zoom + twist-roll), `ConstantControlSpeed`/`KeyboardFly`
  (WASD), `InputController` (front-most pick, long-press pivot, poly/note picks),
  `AutoOrbit`, `CameraPath`, `DragMoveHandle`/`RotateHandle` gizmos, `MeasureView`,
  `PolyhedronPreview`, `NotesView`, `AdaptiveDpr`, `FpsMeter`, `CanvasCapture`,
  `ContextLossGuard` (WebGL context-loss recovery), `CameraSync` (side-by-side
  compare — see below).
- `SettingsPanel.tsx` — quality presets + all perf/render knobs.
- `EditPanels.tsx` — selection / filter / group panels.
- `FloatingPanel.tsx`, `Dropdown.tsx`, `Hist.tsx` — shared UI primitives.

### Side-by-side compare (`splitId` in App + `CameraSync`)

The renderer merges every `SplatObject` into ONE globally-sorted mesh drawn
full-canvas, so a true split view uses **two `<Canvas>`es** — the main scene on
the left (confined to a 50%-width wrapper), the selected compare overlay on the
right (a minimal view-only canvas). Each canvas has its own camera; they're kept
identical by `CameraSync` through a shared `syncCamRef` (`{p, t, version}`).
`CameraSync` decides ownership by **input** (pointerdown/drag/wheel on its own
canvas), not by frame-diffing the pose: the actively-driven canvas publishes its
pose every frame and the idle one adopts it. Deciding by pose-diff instead caused
a one-directional feedback bug (the busy main canvas's `controls.update()` jitter
made it perpetually "the mover"). The compare panel is auto-closed on entry so it
doesn't cover the right canvas's pointer target.

---

## 4. Render data flow (per frame of state)

```
buffer ──(edit/hide/select/scrub)──▶ displayBuffer  [buildDisplayBuffer]
                                          │
                                          ├─ liveBuffer (during a gizmo drag)
                                          ▼
                                   lod / lodSh  [subsampleForLod]  ← renderFrac
                                          ▼
                              <SplatObject buffer=… sh1=…>
                                          ▼
                          sort worker (cam dir) ──▶ sorted indices
                                          ▼
                                   GPU instanced quads
```

- **`displayBuffer`** overlays view-only state (timeline frontier, hide/isolate,
  group-hide, orange selection highlight) on a *copy*, so the real `buffer`
  keeps only committed edits. It returns the **same reference** in the common
  no-overlay case so the renderer can skip re-upload.
- **`bufferRef`** points at `displayBuffer` so picking hits what's visible.
- **`lod`** is the render-only decimation (`renderFrac`); picking/editing still
  use the full buffer.
- The sort worker re-sorts only when the camera direction moves past a
  threshold (`settings.sortThreshold`) — matched to antimatter15/splat.

---

## 5. State ownership (in `App.tsx`)

`App.tsx` is the single owner of scene + editor state. The important groups:

- **Scene:** `buffer`, `sh1`, `bounds`, `frameCum` (delta timeline),
  `sourceRef` (server/test/local — decides what a share link can carry),
  `originalBuffer` (reset target).
- **Selection/edit:** `selection`, `vis` (hide/isolate), `groups`, `undoStack`/
  `redoStack` (byte-capped via `undoCapMB`), live-drag refs
  (`editOrigin`/`workBuf`/`liveBuffer`).
- **Tools:** poly (`polyPts`/`savedRegions`), notes, measure, crop, compare.
- **Camera:** `camApiRef` (imperative bridge into R3F), bookmarks, camera path,
  auto-orbit, tour.
- **Persisted prefs (`vwd:` localStorage):** render `settings`, DPR/`renderFrac`,
  the three sensitivities, `minFps`, `undoCapMB`, `loadDiv`, recents, bookmarks.

Persistence goes exclusively through `lib/storage.ts` helpers — don't call
`localStorage` directly.

---

## 6. Cross-cutting invariants (don't regress these)

1. **antimatter15/splat parity.** Shader math + default `RenderSettings` match
   the reference viewer (blur 0, cull 0, alphaTest 0, black background). The
   `tests/*-roundtrip` + the Playwright occlusion smoke test guard this.
2. **`highp` in shaders.** mediump becomes real fp16 on Apple GPUs and causes
   see-through/x-ray rendering. Keep it highp.
3. **Sorter fallback.** Never assume WASM SIMD is present; `JsSorter` must stay
   a working path (WebKit).
4. **Peak memory ≈ 1× payload.** Streaming conversion, reference-shared
   `originalBuffer`, copy-on-write edits, byte-capped undo. Don't add a
   defensive `.slice()` on the hot load path.
5. **Share links exclude selection and local files** by design; they carry scene
   source + camera + render settings + display opts + notes + camera path.

---

## 7. How to extend

- **A new buffer/selection operation:** add a pure function to
  `lib/gaussianOps.ts`, add a case to `tests/gaussianOps-roundtrip.mts`, then a
  thin wrapper method in `App.tsx` (snapshot → call → `setBuffer`/`setStatus`).
- **A new file format:** add `lib/<fmt>.ts` returning `{ buffer, sh1?, frameCum? }`,
  branch it into `loadLocalFile`, extend the file-input `accept` + drag/drop
  regex. Add a synthetic round-trip test.
- **A new render knob:** add it to `RenderSettings.ts` (with a default that
  preserves parity), thread the uniform in `GaussianSplatsHelpers.ts`, expose it
  in `SettingsPanel.tsx`, and add it to the shareable `rs` subset in `share()`
  if it should travel in links.
- **A new gesture/camera behaviour:** it's an R3F component in
  `SceneObjects.tsx` mounted inside `<Canvas>`, reading `useThree()` — not App
  state.

---

## 8. Build / test / verify

```bash
npm run dev      # vite dev server (localhost:5173)
npm run build    # tsc -b && vite build
npm test         # cov / ply / npz / splat / spz / gaussianOps round-trips
```

Render regression (manual): serve `npm run dev`, drive the synthetic
red-front/blue-back `.splat` through Playwright, screenshot the canvas centre,
assert red wins (correct back-to-front sort). This is the end-to-end check that
the load → displayBuffer → LOD → sort → render pipeline is intact.
