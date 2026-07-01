import React from "react";

/** A toolbar button that opens a small popup menu of buttons (closes on outside
 * click or after choosing an item). `className` (e.g. "menu-only") is applied to
 * the wrapper — note: no inline `display` here so that rule can hide it. */
export function Dropdown({ label, className, children }: {
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (!open) return;
    const onDoc = (e: PointerEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    window.addEventListener("pointerdown", onDoc);
    return () => window.removeEventListener("pointerdown", onDoc);
  }, [open]);
  return (
    <div ref={ref} className={className} style={{ position: "relative" }}>
      <button className={open ? "active" : ""} onClick={() => setOpen((o) => !o)}>{label} ▾</button>
      {open && (
        <div className="panel" style={{ position: "absolute", top: "calc(100% + 4px)", left: 0, minWidth: 150, padding: 6, display: "flex", flexDirection: "column", gap: 4, zIndex: 5 }} onClick={() => setOpen(false)}>
          {children}
        </div>
      )}
    </div>
  );
}
