/** A set of non-negative integer gaussian indices, backed by a dynamically
 * grown bit array (1 bit per index) instead of a JS `Set<number>`.
 *
 * Why: a `Set<number>` costs ~40-80 bytes per element, so selecting all of a
 * 6M-gaussian scene (invert / grow / filter) burns hundreds of MB and thrashes
 * the GC. A packed bitset is N/8 bytes regardless of how many are selected
 * (~750 kB fully selected at 6M) and never allocates per element.
 *
 * The API is a faithful subset of `Set<number>` (`has`, `add`, `delete`,
 * `clear`, `size`, iteration, construction from an iterable) — see
 * selection-roundtrip.mts, which fuzzes it against a reference Set — so it drops
 * in wherever the app used a selection Set. Iteration yields indices in
 * ascending order (Set yields insertion order); no call site depends on order. */
export class Selection implements Iterable<number> {
  private words: Uint32Array;
  private _size = 0;

  constructor(init?: Iterable<number> | null) {
    this.words = new Uint32Array(0);
    if (init) for (const i of init) this.add(i);
  }

  get size(): number {
    return this._size;
  }

  private ensure(word: number): void {
    if (word < this.words.length) return;
    const next = new Uint32Array(Math.max(word + 1, this.words.length * 2, 8));
    next.set(this.words);
    this.words = next;
  }

  has(i: number): boolean {
    if (i < 0) return false;
    const w = i >>> 5;
    return w < this.words.length && (this.words[w] & (1 << (i & 31))) !== 0;
  }

  add(i: number): this {
    if (i < 0 || !Number.isInteger(i)) return this;
    const w = i >>> 5, bit = 1 << (i & 31);
    this.ensure(w);
    if ((this.words[w] & bit) === 0) { this.words[w] |= bit; this._size++; }
    return this;
  }

  delete(i: number): boolean {
    if (i < 0) return false;
    const w = i >>> 5, bit = 1 << (i & 31);
    if (w >= this.words.length || (this.words[w] & bit) === 0) return false;
    this.words[w] &= ~bit;
    this._size--;
    return true;
  }

  clear(): void {
    this.words = new Uint32Array(0);
    this._size = 0;
  }

  *[Symbol.iterator](): Iterator<number> {
    const words = this.words;
    for (let w = 0; w < words.length; w++) {
      const word = words[w];
      if (word === 0) continue;
      const base = w << 5;
      for (let b = 0; b < 32; b++) {
        if (word & (1 << b)) yield base + b;
      }
    }
  }
}
