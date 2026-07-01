import React from "react";

/** Global editor shortcuts: Ctrl/Cmd+Z undo, +Shift/Ctrl+Y redo, Delete, Esc.
 * Actions are read through a ref so the listener binds once but always calls the
 * latest handlers; ignored while typing in a form field. */
export function useKeyboardShortcuts(actions: {
  undo: () => void;
  redo: () => void;
  del: () => void;
  clearSel: () => void;
  hasSel: boolean;
}) {
  const ref = React.useRef(actions);
  ref.current = actions;
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "SELECT" || el.tagName === "TEXTAREA")) return;
      const k = ref.current, key = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && key === "z") { e.preventDefault(); if (e.shiftKey) k.redo(); else k.undo(); }
      else if ((e.ctrlKey || e.metaKey) && key === "y") { e.preventDefault(); k.redo(); }
      else if ((key === "delete" || key === "backspace") && k.hasSel) { e.preventDefault(); k.del(); }
      else if (key === "escape") k.clearSel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
