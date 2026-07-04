/** Public demo scene catalogue + the first-visit default view.
 *
 * These are the .splat scenes the antimatter15/splat demo streams, mirrored on
 * Hugging Face with CORS enabled — handy for testing without a viser server. */

export type TestScene = { name: string; file: string; big?: boolean };

export const TEST_SCENE_CDN = "https://huggingface.co/cakewalk/splat-data/resolve/main/";

export const TEST_SCENES: TestScene[] = [
  { name: "Train", file: "train.splat" },
  { name: "Truck", file: "truck.splat" },
  { name: "Plush", file: "plush.splat" },
  { name: "Bicycle", file: "bicycle.splat", big: true },
  { name: "Garden", file: "garden.splat", big: true },
  { name: "Stump", file: "stump.splat", big: true },
  { name: "Treehill", file: "treehill.splat", big: true },
];

/** First-visit scene: Train auto-loads when the URL doesn't specify a run.
 * Pinned starting camera (copied from 통계 > 카메라 좌표 복사). */
export const DEFAULT_TEST_VIEW: { p: [number, number, number]; t: [number, number, number] } | null = {
  p: [-3.46, -3.853, 0.712],
  t: [-1.434, 0.499, -0.625],
};

/** Recently opened scenes (server runs + CDN test scenes). Local files can't be
 * reopened without a file handle, so they're never recorded here. */
export type Recent =
  | { k: "test"; f: string; label: string }
  | { k: "run"; host: string; run: string; mode: "snapshot" | "delta"; maxFrames: string; label: string };
