import { createContext } from "react";

// ponytail: 떼어온 Splatting 렌더러는 가시성 한 줄
// (viewer.useSceneTree.get(name)?.effectiveVisibility ?? true) 에만 viewer를
// 쓴다. 독립 앱엔 씬트리가 없으므로 get()이 undefined를 돌려주면 ?? true 로
// 항상 보이게 된다. 전체 ViewerContext를 가져오는 대신 이 최소 stub로 충분.
export const ViewerContext = createContext<{
  useSceneTree: { get: (name: string) => { effectiveVisibility?: boolean } | undefined };
}>({
  useSceneTree: { get: () => undefined },
});
