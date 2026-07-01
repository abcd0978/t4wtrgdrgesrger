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
  clipAxis: number; // clipping plane axis: -1 off, 0/1/2 = X/Y/Z
  clipPos: number; // world coord of the clip plane along clipAxis
  clipSign: number; // which side to cut: +1 or -1
}

export const DEFAULT_SETTINGS: RenderSettings = {
  splatScale: 1.0,
  minSplatPx: 2.0,
  maxSplatPx: 1024.0,
  blur: 0.3,
  opacityScale: 1.0,
  cullThreshold: 0.01,
  falloffCutoff: 4.0,
  alphaTest: 0.01,
  fadeSpeed: 2.0,
  clipAxis: -1,
  clipPos: 0,
  clipSign: 1,
};

export const RenderSettingsContext = createContext<RenderSettings>(DEFAULT_SETTINGS);
