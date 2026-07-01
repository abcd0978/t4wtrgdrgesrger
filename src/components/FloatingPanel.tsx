import React from "react";

/** Drag-to-move offset: returns the current translate offset and a pointerdown
 * handler to put on the drag handle (title bar). */
export function useDragOffset() {
  const [off, setOff] = React.useState({ x: 0, y: 0 });
  const startDrag = (e: React.PointerEvent) => {
    e.preventDefault();
    const sx = e.clientX, sy = e.clientY, ox = off.x, oy = off.y;
    const move = (ev: PointerEvent) => setOff({ x: ox + ev.clientX - sx, y: oy + ev.clientY - sy });
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  return { off, startDrag };
}

/** A draggable floating panel (window-like): drag the title bar to move it, and
 * the title bar (with the close X) stays pinned at the top while the body
 * scrolls. `style` sets the initial anchor (top/left/right/bottom); dragging
 * adds a translate offset on top of that. */
export function FloatingPanel({ title, onClose, style, width, className, children }: {
  title: React.ReactNode;
  onClose?: () => void;
  style?: React.CSSProperties;
  width?: string | number;
  className?: string;
  children: React.ReactNode;
}) {
  const { off, startDrag } = useDragOffset();
  const baseTransform = (style?.transform as string) || "";
  return (
    <div className={"panel scroll" + (className ? " " + className : "")} style={{ ...style, width, transform: `${baseTransform} translate(${off.x}px, ${off.y}px)`.trim(), maxHeight: "calc(100dvh - 24px)" }}>
      <div className="panel-titlebar" onPointerDown={startDrag}>
        <span className="panel-title">{title}</span>
        {onClose && <button className="ghost icon" onClick={onClose} onPointerDown={(e) => e.stopPropagation()}>✕</button>}
      </div>
      <div className="panel-section">{children}</div>
    </div>
  );
}
