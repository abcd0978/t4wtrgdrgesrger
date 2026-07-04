/** localStorage persistence helpers. Every viewer preference is stored under the
 * "vwd:" prefix. All accessors swallow storage errors (private mode / disabled
 * storage) and fall back to the supplied default so the app never crashes on a
 * blocked localStorage. */

export const LS = "vwd:";

/** Read a raw string, or `d` when absent / storage is unavailable. */
export const lsGet = (k: string, d: string): string => {
  try { return localStorage.getItem(LS + k) ?? d; } catch { return d; }
};

/** Write a raw string; no-op when storage is unavailable. */
export const lsSet = (k: string, v: string): void => {
  try { localStorage.setItem(LS + k, v); } catch { /* storage unavailable */ }
};

/** Parse a finite float, clamped to [min, max], else the default. */
export const lsNum = (k: string, d: number, min = -Infinity, max = Infinity): number => {
  const v = parseFloat(lsGet(k, String(d)));
  return Number.isFinite(v) && v >= min && v <= max ? v : d;
};

/** "1" -> true, anything else -> false (default `d` when unset). */
export const lsBool = (k: string, d: boolean): boolean => lsGet(k, d ? "1" : "0") === "1";

/** JSON.parse a stored value, or the default on absence / corruption. */
export const lsJson = <T>(k: string, d: T): T => {
  try { return JSON.parse(lsGet(k, "null")) ?? d; } catch { return d; }
};
