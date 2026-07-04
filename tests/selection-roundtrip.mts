/** Proves the bitset-backed Selection behaves identically to a reference
 * Set<number> for every operation the app uses (has / add / delete / size /
 * iteration / construct-from-iterable). This is the safety guarantee behind the
 * Set<number> -> Selection migration: since the app only uses these operations,
 * a faithful match here means the swap is semantically transparent — including
 * on UI paths the browser smoke test doesn't exercise. */
import { Selection } from "../src/lib/selection.ts";

let failures = 0;
const ok = (cond: boolean, msg: string) => { if (!cond) { failures++; console.log("  ✗ " + msg); } };

// Deterministic PRNG (no Math.random) so failures reproduce.
let seed = 0x2545f491;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed; };

// --- fuzz: random add/delete against a reference Set, compare continuously ---
{
  const ref = new Set<number>();
  const sel = new Selection();
  const RANGE = 5000;
  for (let step = 0; step < 60_000; step++) {
    const i = rnd() % RANGE;
    if (rnd() & 1) {
      const a = ref.has(i), b = sel.has(i);
      ref.add(i); sel.add(i);
      ok(a === b, `has() disagreed before add at ${i}`);
    } else {
      const a = ref.delete(i), b = sel.delete(i);
      ok(a === b, `delete() return disagreed at ${i}`);
    }
    if (step % 997 === 0) ok(ref.size === sel.size, `size disagreed: ref ${ref.size} vs sel ${sel.size}`);
  }
  ok(ref.size === sel.size, `final size: ref ${ref.size} vs sel ${sel.size}`);

  // membership matches across the whole range
  let memberMismatch = 0;
  for (let i = 0; i < RANGE; i++) if (ref.has(i) !== sel.has(i)) memberMismatch++;
  ok(memberMismatch === 0, `${memberMismatch} membership mismatches`);

  // iteration yields exactly the same set (order-independent)
  const fromSel = [...sel].sort((a, b) => a - b);
  const fromRef = [...ref].sort((a, b) => a - b);
  ok(fromSel.length === fromRef.length && fromSel.every((v, k) => v === fromRef[k]), "iteration set mismatch");
  ok(fromSel.every((v) => Number.isInteger(v) && v >= 0), "iteration yielded a bad index");
}

// --- construct from an iterable (Set, Array, another Selection) ---
{
  const src = [3, 100, 100, 0, 2048, 63, 64];
  const s = new Selection(src);
  ok(s.size === new Set(src).size, "constructor de-dupes like Set");
  ok(s.has(0) && s.has(2048) && s.has(63) && s.has(64) && !s.has(1), "constructor membership");
  const copy = new Selection(s);
  ok([...copy].join() === [...s].join(), "copy-construct from Selection matches");
  // mutating the copy doesn't touch the original
  copy.add(9999); copy.delete(3);
  ok(s.has(3) && !s.has(9999), "copy is independent");
}

// --- edge cases the app can hit ---
{
  const s = new Selection();
  ok(s.size === 0 && !s.has(0), "empty selection");
  s.add(0); ok(s.has(0) && s.size === 1, "add index 0 (bit 0)");
  s.add(31); s.add(32); ok(s.has(31) && s.has(32) && s.size === 3, "word boundary (31/32)");
  ok(s.delete(0) === true && s.delete(0) === false, "double-delete returns false");
  s.add(-5 as number); ok(!s.has(-5) && s.size === 2, "negative index ignored");
  s.clear(); ok(s.size === 0 && !s.has(31), "clear empties");
}

if (failures) { console.log(`selection: ${failures} FAIL`); process.exit(1); }
console.log("selection (bitset ≡ Set): PASS");
