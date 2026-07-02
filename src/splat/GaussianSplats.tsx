/** Gaussian splatting implementation for viser.
 *
 * This borrows heavily from existing open-source implementations. Particularly
 * useful references:
 * - https://github.com/quadjr/aframe-gaussian-splatting
 * - https://github.com/antimatter15/splat
 * - https://github.com/pmndrs/drei
 * - https://github.com/vincent-lecrubier-skydio/react-three-fiber-gaussian-splat
 *
 * Usage should look like:
 *
 * <Canvas>
 *   <SplatRenderContext>
 *     <SplatObject buffer={buffer} />
 *   </SplatRenderContext>
 * </Canvas>
 *
 * Where `buffer` contains serialized Gaussian attributes. SplatObjects are
 * globally sorted by a worker (with some help from WebAssembly + SIMD
 * intrinsics), and then rendered as a single threejs mesh. Unlike other R3F
 * implementations that we're aware of, this enables correct compositing
 * between multiple splat objects.
 */

// Diagnostic escape hatch: append ?jssort to the URL to force the worker's
// pure-JS sorter (bypasses the SIMD WASM module entirely).
const FORCE_JS_SORT =
  typeof location !== "undefined" && /[?&]jssort\b/.test(location.search);

import React from "react";
import * as THREE from "three";
import SplatSortWorker from "./SplatSortWorker?worker&inline";
import { useFrame, useThree } from "@react-three/fiber";
import { SorterWorkerIncoming } from "./SplatSortWorker";
import { v4 as uuidv4 } from "uuid";

import {
  GaussianSplatsContext,
  createGaussianMeshProps,
  useGaussianSplatStore,
  type GaussianMeshProps,
} from "./GaussianSplatsHelpers";
import { ViewerContext } from "../ViewerContext";
import { RenderSettingsContext } from "../RenderSettings";

/**Provider for creating splat rendering context.*/
export function SplatRenderContext({
  children,
}: {
  children: React.ReactNode;
}) {
  const splatState = useGaussianSplatStore();
  return (
    <GaussianSplatsContext.Provider
      value={{
        gaussianSplatState: splatState,
        updateCamera: React.useRef(null),
        meshPropsRef: React.useRef(null),
      }}
    >
      <SplatRenderer />
      {children}
    </GaussianSplatsContext.Provider>
  );
}
export const SplatObject = React.forwardRef<
  THREE.Group,
  {
    buffer: Uint32Array;
    sh1?: Uint32Array | null; // optional degree-1 SH side buffer (8 u32/gaussian)
    sceneNodeName?: string;
    children?: React.ReactNode;
  }
>(function SplatObject({ buffer, sh1, sceneNodeName, children }, ref) {
  const splatContext = React.useContext(GaussianSplatsContext)!;
  const { setBuffer, removeBuffer } = splatContext.gaussianSplatState.actions;
  const nodeRefFromId = splatContext.gaussianSplatState.store(
    (state) => state.nodeRefFromId,
  );
  const sceneNodeNameFromId = splatContext.gaussianSplatState.store(
    (state) => state.sceneNodeNameFromId,
  );
  // Use stable ID per component instance (not dependent on buffer).
  const name = React.useMemo(() => uuidv4(), []);

  // Cleanup only on unmount.
  React.useEffect(() => {
    return () => {
      removeBuffer(name);
      delete nodeRefFromId.current[name];
      delete sceneNodeNameFromId.current[name];
    };
  }, [name, removeBuffer, nodeRefFromId, sceneNodeNameFromId]);

  // Update buffer when it changes.
  React.useEffect(() => {
    setBuffer(name, buffer, sh1);
  }, [name, buffer, sh1, setBuffer]);

  return (
    <group
      ref={(obj) => {
        // We'll (a) forward the ref and (b) store it in the splat rendering
        // state. The latter is used to update the sorter and shader.
        if (obj === null) return;
        if (ref !== null) {
          if ("current" in ref) {
            ref.current = obj;
          } else {
            ref(obj);
          }
        }
        nodeRefFromId.current[name] = obj;
        if (sceneNodeName !== undefined) {
          sceneNodeNameFromId.current[name] = sceneNodeName;
        }
      }}
    >
      {children}
    </group>
  );
});

/** External interface. Component should be added to the root of canvas.  */
function SplatRenderer() {
  const splatContext = React.useContext(GaussianSplatsContext)!;
  const groupBufferFromId = splatContext.gaussianSplatState.store(
    (state) => state.groupBufferFromId,
  );

  // Only mount implementation (which will load sort worker, etc) if there are
  // Gaussians to render.
  return Object.keys(groupBufferFromId).length > 0 ? (
    <SplatRendererImpl />
  ) : null;
}

function SplatRendererImpl() {
  const splatContext = React.useContext(GaussianSplatsContext)!;
  const viewer = React.useContext(ViewerContext)!;
  const settings = React.useContext(RenderSettingsContext);
  // Ref mirror so updateCamera (a stable callback) reads live settings.
  const settingsRef = React.useRef(settings);
  settingsRef.current = settings;
  const groupBufferFromId = splatContext.gaussianSplatState.store(
    (state) => state.groupBufferFromId,
  );
  const groupShFromId = splatContext.gaussianSplatState.store(
    (state) => state.groupShFromId,
  );
  const nodeRefFromId = splatContext.gaussianSplatState.store(
    (state) => state.nodeRefFromId,
  );
  const sceneNodeNameFromId = splatContext.gaussianSplatState.store(
    (state) => state.sceneNodeNameFromId,
  );
  const maxTextureSize = useThree((state) => state.gl).capabilities
    .maxTextureSize;

  // Refs to persist resources across re-renders.
  const sortWorkerRef = React.useRef<Worker | null>(null);
  const meshPropsRef = React.useRef<GaussianMeshProps | null>(null);
  const prevMergedRef = React.useRef<{
    gaussianBuffer: Uint32Array;
    numGaussians: number;
    numGroups: number;
    groupIndices: Uint32Array;
    shBuffer: Uint32Array | null;
  } | null>(null);
  const isFirstRenderRef = React.useRef(true);
  const initializedBufferTextureRef = React.useRef(false);

  // Force component to re-render when mesh props change.
  const [, forceUpdate] = React.useReducer((x) => x + 1, 0);

  // Consolidate Gaussian groups into a single buffer.
  // Memoized on groupBufferFromId reference -- the store returns the same
  // reference when state hasn't changed, so this avoids re-merging every render.
  const merged = React.useMemo(
    () =>
      mergeGaussianGroups(
        groupBufferFromId,
        groupShFromId,
        // Reuse the all-zero groupIndices only if the previous merge was also
        // single-group (multi-group arrays contain non-zero entries).
        prevMergedRef.current?.numGroups === 1
          ? prevMergedRef.current.groupIndices
          : undefined,
      ),
    [groupBufferFromId, groupShFromId],
  );

  // Helper function to post messages to worker.
  const postToWorker = React.useCallback((message: SorterWorkerIncoming) => {
    if (sortWorkerRef.current) {
      sortWorkerRef.current.postMessage(message);
    }
  }, []);

  // Check if buffer content has changed (reference equality, since merged is memoized).
  const bufferChanged =
    !prevMergedRef.current ||
    merged.gaussianBuffer !== prevMergedRef.current.gaussianBuffer;

  // Check if number of Gaussians or groups changed (requires texture resize).
  // SH presence flipping also needs a rebuild (dummy 1x1 vs full-size texture).
  const sizeChanged =
    prevMergedRef.current &&
    (merged.numGaussians !== prevMergedRef.current.numGaussians ||
      merged.numGroups !== prevMergedRef.current.numGroups ||
      (merged.shBuffer != null) !== (prevMergedRef.current.shBuffer != null));

  // Initialize resources on first render.
  if (isFirstRenderRef.current) {
    // Create mesh props.
    meshPropsRef.current = createGaussianMeshProps(
      merged.gaussianBuffer,
      merged.numGroups,
      maxTextureSize,
      merged.shBuffer,
    );

    // Show splats immediately with identity sort order. This makes splats
    // visible before the WASM sorter finishes compiling + first sort, at the
    // cost of incorrect back-to-front ordering until the sort completes.
    const numGaussians = meshPropsRef.current.numGaussians;
    const identityIndices = meshPropsRef.current.sortedIndexAttribute
      .array as Uint32Array;
    for (let i = 0; i < numGaussians; i++) {
      identityIndices[i] = i;
    }
    meshPropsRef.current.sortedIndexAttribute.needsUpdate = true;
    meshPropsRef.current.material.uniforms.numGaussians.value = numGaussians;
    meshPropsRef.current.textureBuffer.needsUpdate = true;
    initializedBufferTextureRef.current = true;

    // Create sorting worker.
    sortWorkerRef.current = new SplatSortWorker();
    sortWorkerRef.current.onmessage = (e) => {
      const sortedIndices = e.data.sortedIndices as Uint32Array;
      if (meshPropsRef.current) {
        // Handle case where sorted indices might be from a previous buffer size.
        if (sortedIndices.length === meshPropsRef.current.numGaussians) {
          meshPropsRef.current.sortedIndexAttribute.set(sortedIndices);
          meshPropsRef.current.sortedIndexAttribute.needsUpdate = true;
        }
      }
      // Hand the buffer back to the worker for reuse (transfer, zero-copy):
      // the attribute made its own copy above, so we don't need it anymore.
      (e.target as Worker).postMessage({ recycleBuffer: sortedIndices }, [
        sortedIndices.buffer,
      ]);
    };

    // Send initial buffer to worker.
    postToWorker({
      setBuffer: merged.gaussianBuffer,
      setGroupIndices: merged.groupIndices,
      forceJsSort: FORCE_JS_SORT,
    });

    prevMergedRef.current = merged;
    isFirstRenderRef.current = false;
  } else if (bufferChanged && meshPropsRef.current) {
    // Handle buffer updates.
    if (sizeChanged) {
      // Size changed - need to recreate mesh props.
      const oldProps = meshPropsRef.current;

      // Create new mesh props with new size.
      meshPropsRef.current = createGaussianMeshProps(
        merged.gaussianBuffer,
        merged.numGroups,
        maxTextureSize,
        merged.shBuffer,
      );

      // Dispose old resources.
      oldProps.textureBuffer.dispose();
      oldProps.geometry.dispose();
      oldProps.material.dispose();
      oldProps.textureT_camera_groups.dispose();
      oldProps.textureSh.dispose();

      // Seed identity draw order so every Gaussian is visible immediately. The
      // new sortedIndex attribute is all-zeros otherwise, which collapses every
      // instance onto Gaussian 0 until the worker re-sorts — and the worker only
      // re-sorts on camera movement, so without this a size change with a still
      // camera (e.g. changing the LOD slider) makes everything vanish.
      {
        const idx = meshPropsRef.current.sortedIndexAttribute.array as Uint32Array;
        for (let i = 0; i < merged.numGaussians; i++) idx[i] = i;
        meshPropsRef.current.sortedIndexAttribute.needsUpdate = true;
      }

      // Update worker with new buffer.
      postToWorker({
        updateBuffer: merged.gaussianBuffer,
        updateGroupIndices: merged.groupIndices,
      });

      // Skip fade-in animation on updates, set numGaussians immediately.
      meshPropsRef.current.material.uniforms.transitionInState.value = 1.0;
      meshPropsRef.current.material.uniforms.numGaussians.value =
        merged.numGaussians;
      meshPropsRef.current.textureBuffer.needsUpdate = true;

      // Force re-render to update the mesh component.
      forceUpdate();
    } else {
      // Same size - update texture data in place.
      const textureData = meshPropsRef.current.textureBuffer.image
        .data as Uint32Array;
      textureData.fill(0);
      textureData.set(merged.gaussianBuffer);
      meshPropsRef.current.textureBuffer.needsUpdate = true;
      if (meshPropsRef.current.hasSh && merged.shBuffer) {
        const shData = meshPropsRef.current.textureSh.image.data as Uint32Array;
        shData.fill(0);
        shData.set(merged.shBuffer.subarray(0, Math.min(merged.shBuffer.length, shData.length)));
        meshPropsRef.current.textureSh.needsUpdate = true;
      }

      // The sort order depends only on POSITIONS (+ groups). Colour/alpha-only
      // updates — selection highlight, hide/isolate, timeline scrubbing,
      // recolor, delete — leave positions untouched, and re-uploading to the
      // worker costs a full structured clone + WASM rebuild + resort (the
      // "browser hangs when selecting" on multi-million-splat scenes). Compare
      // the xyz words (~20ms for 6M splats) and skip the worker when equal.
      {
        const prevBuf = prevMergedRef.current!.gaussianBuffer;
        const newBuf = merged.gaussianBuffer;
        let positionsChanged = false;
        for (let i = 0; i < newBuf.length; i += 8) {
          if (
            newBuf[i] !== prevBuf[i] ||
            newBuf[i + 1] !== prevBuf[i + 1] ||
            newBuf[i + 2] !== prevBuf[i + 2]
          ) {
            positionsChanged = true;
            break;
          }
        }
        if (positionsChanged) {
          postToWorker({
            updateBuffer: merged.gaussianBuffer,
            updateGroupIndices: merged.groupIndices,
          });
        }
      }

      // Skip fade-in animation on updates.
      meshPropsRef.current.material.uniforms.transitionInState.value = 1.0;
    }

    prevMergedRef.current = merged;
  }

  // Keep context meshPropsRef in sync.
  splatContext.meshPropsRef.current = meshPropsRef.current;

  // Cleanup on unmount only.
  React.useEffect(() => {
    return () => {
      if (meshPropsRef.current) {
        meshPropsRef.current.textureBuffer.dispose();
        meshPropsRef.current.geometry.dispose();
        meshPropsRef.current.material.dispose();
        meshPropsRef.current.textureT_camera_groups.dispose();
        meshPropsRef.current.textureSh.dispose();
      }
      if (sortWorkerRef.current) {
        sortWorkerRef.current.postMessage({ close: true });
      }
    };
  }, []);

  // Per-frame updates. This is in charge of synchronizing transforms and
  // triggering sorting.
  //
  // We pre-allocate matrices to make life easier for the garbage collector.
  const meshRef = React.useRef<THREE.Mesh>(null);
  const tmpT_camera_group = React.useMemo(() => new THREE.Matrix4(), []);
  const Tz_camera_groupsRef = React.useRef<Float32Array>(
    new Float32Array(merged.numGroups * 4),
  );
  const prevRowMajorT_camera_groupsRef = React.useRef<Float32Array>(
    new Float32Array(0),
  );
  // Tz values at the time of the LAST sort request (not the last frame), so
  // slow continuous motion still accumulates past the threshold and re-sorts.
  const lastSortTzRef = React.useRef<Float32Array>(new Float32Array(0));
  const prevVisiblesRef = React.useRef<boolean[]>([]);

  // Update Tz_camera_groups size if numGroups changed.
  if (Tz_camera_groupsRef.current.length !== merged.numGroups * 4) {
    Tz_camera_groupsRef.current = new Float32Array(merged.numGroups * 4);
  }

  // Track previous camera parameters to avoid redundant updates.
  const prevCameraParams = React.useRef({
    fovY: 0,
    aspect: 0,
    near: 0,
    far: 0,
  });

  // Store projection matrix for 1-frame delay to match texture upload timing.
  const pendingProjectionMatrix = React.useRef(
    new THREE.Matrix4().makePerspective(-1, 1, 1, -1, 0.1, 1000),
  );

  // NOTE: there used to be a SECOND, main-thread WASM Sorter here for
  // "blocking" sorts, but nothing in this app ever calls updateCamera with
  // blockingSort=true — and it duplicated the whole scene inside the WASM
  // heap (~300MB peak on 6M-splat scenes). Removed; the worker owns sorting.

  const updateCamera = React.useCallback(
    function updateCamera(
      camera: THREE.PerspectiveCamera,
      width: number,
      height: number,
      blockingSort: boolean,
    ) {
      const meshProps = meshPropsRef.current;
      if (meshProps === null) return;

      // Force immediate camera matrix updates to avoid lag.
      camera.updateMatrixWorld(true);
      camera.updateProjectionMatrix();

      // Update camera parameter uniforms.
      const fovY = ((camera as THREE.PerspectiveCamera).fov * Math.PI) / 180.0;
      const aspect = width / height;

      if (meshProps.material === undefined) return;

      const uniforms = meshProps.material.uniforms;
      uniforms.near.value = camera.near;
      uniforms.far.value = camera.far;
      uniforms.viewport.value = [width, height];

      const Tz_camera_groups = Tz_camera_groupsRef.current;
      const prevVisibles = prevVisiblesRef.current;

      // Ensure prevRowMajorT_camera_groups has correct size.
      if (
        prevRowMajorT_camera_groupsRef.current.length !==
        meshProps.rowMajorT_camera_groups.length
      ) {
        prevRowMajorT_camera_groupsRef.current =
          meshProps.rowMajorT_camera_groups.slice().fill(0);
      }
      const prevRowMajorT_camera_groups =
        prevRowMajorT_camera_groupsRef.current;

      // Update group transforms.
      const T_camera_world = camera.matrixWorldInverse;
      const groupVisibles: boolean[] = [];
      let visibilitiesChanged = false;
      for (const [groupIndex, name] of Object.keys(
        groupBufferFromId,
      ).entries()) {
        const node = nodeRefFromId.current[name];
        if (node === undefined) continue;
        tmpT_camera_group.copy(T_camera_world).multiply(node.matrixWorld);
        const colMajorElements = tmpT_camera_group.elements;
        Tz_camera_groups.set(
          [
            colMajorElements[2],
            colMajorElements[6],
            colMajorElements[10],
            colMajorElements[14],
          ],
          groupIndex * 4,
        );
        const rowMajorElements = tmpT_camera_group.transpose().elements;
        meshProps.rowMajorT_camera_groups.set(
          rowMajorElements.slice(0, 12),
          groupIndex * 12,
        );

        // Determine visibility from the scene tree's precomputed
        // effectiveVisibility, which accounts for the full parent chain.
        const sceneNodeName = sceneNodeNameFromId.current[name];
        const sceneNode = sceneNodeName
          ? viewer.useSceneTree.get(sceneNodeName)
          : undefined;
        const visibleNow =
          node.parent !== null && (sceneNode?.effectiveVisibility ?? true);
        groupVisibles.push(visibleNow);
        if (prevVisibles[groupIndex] !== visibleNow) {
          prevVisibles[groupIndex] = visibleNow;
          visibilitiesChanged = true;
        }
      }

      const groupsMovedWrtCam = !meshProps.rowMajorT_camera_groups.every(
        (v, i) => v === prevRowMajorT_camera_groups[i],
      );

      if (groupsMovedWrtCam) {
        // Gaussians need to be re-sorted -- but only when the view actually
        // rotated / translated enough to change the depth order. Sorting on
        // every float change made camera drags re-sort (and re-upload the
        // index buffer) in a continuous loop. Following antimatter15's
        // heuristic: skip the sort while the view-direction dot product stays
        // within 0.01 of the last-sorted direction; a depth-translation term
        // (relative to the group's distance) covers WASD-style flying.
        const lastSortTz = lastSortTzRef.current;
        const st = settingsRef.current.sortThreshold;
        let sortNeeded = lastSortTz.length !== Tz_camera_groups.length;
        for (let g = 0; !sortNeeded && g * 4 < Tz_camera_groups.length; g++) {
          const i = g * 4;
          const dot =
            Tz_camera_groups[i] * lastSortTz[i] +
            Tz_camera_groups[i + 1] * lastSortTz[i + 1] +
            Tz_camera_groups[i + 2] * lastSortTz[i + 2];
          const dtz = Math.abs(Tz_camera_groups[i + 3] - lastSortTz[i + 3]);
          if (Math.abs(dot - 1) > st || dtz > st * (1.0 + Math.abs(lastSortTz[i + 3])))
            sortNeeded = true;
        }
        if (sortNeeded) {
          postToWorker({
            setTz_camera_groups: Tz_camera_groups,
          });
          if (lastSortTzRef.current.length !== Tz_camera_groups.length)
            lastSortTzRef.current = new Float32Array(Tz_camera_groups.length);
          lastSortTzRef.current.set(Tz_camera_groups);
        }
      }
      if (groupsMovedWrtCam || visibilitiesChanged) {
        // If a group is not visible, throw it off the screen.
        for (const [i, visible] of groupVisibles.entries()) {
          if (!visible) {
            meshProps.rowMajorT_camera_groups[i * 12 + 3] = 1e10;
            meshProps.rowMajorT_camera_groups[i * 12 + 7] = 1e10;
            meshProps.rowMajorT_camera_groups[i * 12 + 11] = 1e10;
          }
        }
        prevRowMajorT_camera_groups.set(meshProps.rowMajorT_camera_groups);
        meshProps.textureT_camera_groups.needsUpdate = true;
      }

      // Apply the previous frame's projection matrix (1-frame delay for sync with texture).
      meshProps.material.uniforms.projectionMatrixCustom.value.copy(
        pendingProjectionMatrix.current,
      );

      // Calculate projection matrix for next frame (only if parameters changed).
      const near = camera.near;
      const far = camera.far;
      const params = prevCameraParams.current;

      if (
        fovY !== params.fovY ||
        aspect !== params.aspect ||
        near !== params.near ||
        far !== params.far
      ) {
        const tanHalfFovY = Math.tan(fovY / 2);
        const top = near * tanHalfFovY;
        const bottom = -top;
        const right = top * aspect;
        const left = -right;

        pendingProjectionMatrix.current.makePerspective(
          left,
          right,
          top,
          bottom,
          near,
          far,
          THREE.WebGLCoordinateSystem,
          camera.reversedDepth,
        );

        params.fovY = fovY;
        params.aspect = aspect;
        params.near = near;
        params.far = far;
      }
    },
    [
      groupBufferFromId,
      nodeRefFromId,
      sceneNodeNameFromId,
      viewer,
      tmpT_camera_group,
      postToWorker,
    ],
  );
  splatContext.updateCamera.current = updateCamera;

  useFrame((state, delta) => {
    const mesh = meshRef.current;
    const meshProps = meshPropsRef.current;
    if (
      mesh === null ||
      meshProps === null ||
      sortWorkerRef.current === null ||
      meshProps.rowMajorT_camera_groups.length === 0
    )
      return;

    const uniforms = meshProps.material.uniforms;
    // Live render settings from the UI.
    uniforms.splatScale.value = settings.splatScale;
    uniforms.minSplatPx.value = settings.minSplatPx;
    uniforms.maxSplatPx.value = settings.maxSplatPx;
    uniforms.blur.value = settings.blur;
    uniforms.opacityScale.value = settings.opacityScale;
    uniforms.cullThreshold.value = settings.cullThreshold;
    uniforms.falloffCutoff.value = settings.falloffCutoff;
    uniforms.alphaTest.value = settings.alphaTest;
    uniforms.clipAxis.value = settings.clipAxis;
    uniforms.clipPos.value = settings.clipPos;
    uniforms.clipSign.value = settings.clipSign;
    uniforms.cropEnable.value = settings.cropOn;
    (uniforms.cropMin.value as THREE.Vector3).fromArray(settings.cropMin);
    (uniforms.cropMax.value as THREE.Vector3).fromArray(settings.cropMax);
    uniforms.wipeEnable.value = settings.wipeOn;
    uniforms.wipePos.value = settings.wipePos;
    uniforms.shEnable.value = meshProps.hasSh && settings.shOn ? 1.0 : 0.0;
    uniforms.lodDist.value = settings.lodDistWorld;
    uniforms.transitionInState.value = Math.min(
      uniforms.transitionInState.value + delta * settings.fadeSpeed,
      1.0,
    );

    updateCamera(
      state.camera as THREE.PerspectiveCamera,
      state.viewport.dpr * state.size.width,
      state.viewport.dpr * state.size.height,
      false /* blockingSort */,
    );
  }, -100 /* This should be called early to reduce group transform artifacts. */);

  const meshProps = meshPropsRef.current!;
  return (
    <mesh
      ref={meshRef}
      geometry={meshProps.geometry}
      material={meshProps.material}
      renderOrder={10000.0 /*Generally, we want to render last.*/}
      frustumCulled={false /* 2D quad position -> NaN boundingSphere; splats always drawn */}
    />
  );
}

/**Consolidate groups of Gaussians into a single buffer, to make it possible
 * for them to be sorted globally. SH side buffers (8 u32/gaussian, same
 * stride as the base) merge in the same order; groups without SH (or with a
 * stale length after edits) are zero-filled, which the shader reads as "no
 * view-dependent term".*/
function mergeGaussianGroups(
  groupBufferFromName: { [name: string]: Uint32Array },
  groupShFromName: { [name: string]: Uint32Array | undefined } = {},
  prevGroupIndices?: Uint32Array,
) {
  // Create geometry. Each Gaussian will be rendered as a quad.
  let totalBufferLength = 0;
  for (const buffer of Object.values(groupBufferFromName)) {
    totalBufferLength += buffer.length;
  }
  const numGaussians = totalBufferLength / 8;
  const names = Object.keys(groupBufferFromName);

  // Single-group fast path (the common case: no compare overlays): the packed
  // format already carries group index 0 in word 3 of every gaussian, so the
  // group buffer can be used as-is — no 32B/gaussian merge copy (~190MB saved
  // per edit on 6M-splat scenes). The all-zero groupIndices array is reused
  // across merges of the same size for the same reason.
  if (names.length === 1) {
    const buffer0 = groupBufferFromName[names[0]];
    const groupIndices =
      prevGroupIndices && prevGroupIndices.length === numGaussians
        ? prevGroupIndices
        : new Uint32Array(numGaussians);
    const sh = groupShFromName[names[0]];
    let shBuffer: Uint32Array | null = null;
    if (sh) {
      if (sh.length === buffer0.length) shBuffer = sh;
      else {
        shBuffer = new Uint32Array(buffer0.length);
        shBuffer.set(sh.subarray(0, Math.min(sh.length, buffer0.length)));
      }
    }
    return { numGaussians, gaussianBuffer: buffer0, numGroups: 1, groupIndices, shBuffer };
  }

  const gaussianBuffer = new Uint32Array(totalBufferLength);
  const groupIndices = new Uint32Array(numGaussians);
  const anySh = names.some((name) => groupShFromName[name] != null);
  const shBuffer = anySh ? new Uint32Array(totalBufferLength) : null;

  let offset = 0;
  for (const [groupIndex, [name, groupBuffer]] of Object.entries(
    groupBufferFromName,
  ).entries()) {
    groupIndices.fill(
      groupIndex,
      offset / 8,
      (offset + groupBuffer.length) / 8,
    );
    gaussianBuffer.set(groupBuffer, offset);
    const sh = groupShFromName[name];
    if (shBuffer && sh) {
      shBuffer.set(sh.subarray(0, Math.min(sh.length, groupBuffer.length)), offset);
    }

    // Each Gaussian is allocated
    // - 12 bytes for center x, y, z (float32)
    // - 4 bytes for group index (uint32); we're filling this in now
    //
    // - 12 bytes for covariance (6 terms, float16)
    // - 4 bytes for RGBA (uint8)
    for (let i = 0; i < groupBuffer.length; i += 8) {
      gaussianBuffer[offset + i + 3] = groupIndex;
    }
    offset += groupBuffer.length;
  }

  const numGroups = Object.keys(groupBufferFromName).length;
  return { numGaussians, gaussianBuffer, numGroups, groupIndices, shBuffer };
}
