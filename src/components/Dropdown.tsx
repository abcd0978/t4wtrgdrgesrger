import React from "react";
import { createPortal } from "react-dom";

/** A toolbar button that opens a small popup menu of buttons. The menu is
 * portaled to <body> and fixed-positioned under the button, so it isn't clipped
 * by the toolbar's overflow or hidden behind the canvas. Closes on outside
 * click, item click, scroll, or resize. `className` applies to the wrapper. */
export function Dropdown({ label, className, children }: {
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(false);
  const [pos, setPos] = React.useState<{ left: number; top: number } | null>(null);
  const btnRef = React.useRef<HTMLButtonElement>(null);
  const menuRef = React.useRef<HTMLDivElement>(null);

  const toggle = () => {
    const r = btnRef.current?.getBoundingClientRect();
    if (r) setPos({ left: r.left, top: r.bottom + 4 });
    setOpen((o) => !o);
  };

  // once the menu has rendered we know its width; nudge it left so it never
  // spills off the right edge (common on phones when the button is near the edge).
  React.useLayoutEffect(() => {
    if (!open || !pos || !menuRef.current) return;
    const w = menuRef.current.offsetWidth;
    const clamped = Math.max(8, Math.min(pos.left, window.innerWidth - w - 8));
    if (clamped !== pos.left) setPos({ left: clamped, top: pos.top });
  }, [open, pos]);

  React.useEffect(() => {
    if (!open) return;
    const onDoc = (e: PointerEvent) => {
      if (btnRef.current?.contains(e.target as Node) || menuRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    const close = () => setOpen(false);
    window.addEventListener("pointerdown", onDoc);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("pointerdown", onDoc);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [open]);

  return (
    <span className={className}>
      <button ref={btnRef} className={open ? "active" : ""} onClick={toggle}>{label} ▾</button>
      {open && pos && createPortal(
        <div ref={menuRef} className="panel" style={{
          position: "fixed", left: pos.left, top: pos.top, minWidth: 150, maxWidth: "calc(100vw - 20px)",
          padding: 6, display: "flex", flexDirection: "column", gap: 4, zIndex: 50,
        }} onClick={() => setOpen(false)}>
          {children}
        </div>,
        document.body,
      )}
    </span>
  );
}
