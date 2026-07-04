import React from "react";

/** Top-level error boundary: a render/runtime error anywhere in the tree shows
 * a recovery card (with the message + a reload) instead of a blank white page.
 * WebGL *context* loss is not a React error — that's handled separately inside
 * the Canvas (see ContextLossGuard) — this catches JS exceptions in render. */
export class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("[viewer] uncaught error", error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div style={{
        position: "fixed", inset: 0, display: "flex", alignItems: "center", justifyContent: "center",
        background: "#000", color: "#eee", padding: 24, fontFamily: "system-ui, sans-serif",
      }}>
        <div style={{ maxWidth: 460, textAlign: "center" }}>
          <div style={{ fontSize: 22, marginBottom: 8 }}>문제가 발생했습니다</div>
          <div style={{ opacity: 0.75, fontSize: 13, marginBottom: 16, wordBreak: "break-word" }}>
            {String(this.state.error?.message || this.state.error)}
          </div>
          <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
            <button onClick={() => this.setState({ error: null })} style={btn}>다시 시도</button>
            <button onClick={() => location.reload()} style={btn}>새로고침</button>
          </div>
          <div style={{ opacity: 0.5, fontSize: 11, marginTop: 14 }}>
            반복되면 새로고침하거나 더 작은 씬으로 다시 열어보세요.
          </div>
        </div>
      </div>
    );
  }
}

const btn: React.CSSProperties = {
  padding: "8px 16px", borderRadius: 8, border: "1px solid #444",
  background: "#1a1a1a", color: "#eee", cursor: "pointer", fontSize: 14,
};
