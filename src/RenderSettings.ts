import { createContext } from "react";

/** Live-tunable render constants (shader uniforms + JS-side knobs). */
export interface RenderSettings {
  splatScale: number; // overall splat size multiplier
  minSplatPx: number; // min on-screen size (distant gaussians stay visible)
  maxSplatPx: number; // max on-screen size
  blur: number; // 2D dilation / antialias (added to screen-space covariance diag)
  opacityScale: number; // global opacity multiplier
  cullThreshold: number; // drop splats whose weighted determinant is below this
  falloffCutoff: number; // gaussian tail cutoff radius² (fragment discard)
  alphaTest: number; // discard fragments below this alpha
  fadeSpeed: number; // fade-in animation speed
  sortThreshold: number; // re-sort when view rotates past |dot-1| (0 = every move)
  clipAxis: number; // clipping plane axis: -1 off, 0/1/2 = X/Y/Z
  clipPos: number; // world coord of the clip plane along clipAxis
  clipSign: number; // which side to cut: +1 or -1
  cropOn: number; // 1 = crop-box preview active (shader-side, non-destructive)
  cropMin: [number, number, number]; // crop box corners (world coords)
  cropMax: [number, number, number];
  wipeOn: number; // 1 = A/B wipe: main scene left of the divider, overlays right
  wipePos: number; // divider position as a screen fraction (0..1)
  shOn: number; // 1 = evaluate degree-1 SH (view-dependent colour) when the data has it
}

// Defaults match antimatter15/splat's (hardcoded) shader behaviour: no size
// clamp, no dilation, and no culling — every gaussian is drawn and only the
// exp falloff tail (radius² > 4) is discarded. The previous defaults
// (minSplatPx 2, cullThreshold 0.01, alphaTest 0.01) dropped or dot-ified
// small faint splats, which reads as a sparse/grainy surface — especially at
// dpr 1, where screen-space covariances shrink and the cull bites harder.
export const DEFAULT_SETTINGS: RenderSettings = {
  splatScale: 1.0,
  minSplatPx: 0.0,
  maxSplatPx: 1024.0,
  blur: 0.0,
  opacityScale: 1.0,
  cullThreshold: 0.0,
  falloffCutoff: 4.0,
  alphaTest: 0.0,
  fadeSpeed: 2.0,
  sortThreshold: 0.01, // antimatter15's value (~8° of rotation)
  clipAxis: -1,
  clipPos: 0,
  clipSign: 1,
  cropOn: 0,
  cropMin: [0, 0, 0],
  cropMax: [0, 0, 0],
  wipeOn: 0,
  wipePos: 0.5,
  shOn: 1,
};

export const RenderSettingsContext = createContext<RenderSettings>(DEFAULT_SETTINGS);
