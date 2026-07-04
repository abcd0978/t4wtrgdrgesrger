# AGENT

Architecture notes for anyone (human or agent) working on this repo.

- **[ARCHITECTURE.md](./ARCHITECTURE.md)** — the map: the packed-gaussian data
  model, the layering (orchestration vs. pure `lib/` vs. R3F rendering), the
  module-by-module responsibilities, the render data flow, state ownership, the
  invariants you must not regress, and how to extend each layer.

## TL;DR conventions

- One data structure runs the whole app: a flat `Uint32Array`, 32 bytes per
  gaussian, `alpha == 0` = deleted. Edits are copy-on-write.
- `lib/` is **pure** (no React/DOM). New buffer/selection math goes in
  `lib/gaussianOps.ts` with a test in `tests/gaussianOps-roundtrip.mts`.
- `App.tsx` orchestrates; its methods stay thin (snapshot → call kernel →
  `setBuffer`/`setStatus`).
- Persistence only via `lib/storage.ts` (`vwd:` prefix).
- Don't regress: antimatter15 parity, `highp` shaders, the JS sort fallback,
  ~1× peak memory. See ARCHITECTURE.md §6.
- `npm test` must stay green (round-trip + kernel tests).
