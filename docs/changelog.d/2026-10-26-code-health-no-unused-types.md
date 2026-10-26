## 2026-10-26 — Code-health ratchet no longer checks unused exported types

- `scripts/check-code-health.mjs` now asks Knip only for unused files, unused exports and
  duplicate exports. Unused exported TYPES are dropped: exporting the parameter or result type
  of a shared function is normal practice even when no other file names it.
- Why: a read-only pre-check of the queued PRs (#1102, #1103, #1105, #1114, #1115) merged into
  #1117 showed that category failing four of five ordinary changes (for example a new
  `ProductMarginFloor` type in `src/types/index.ts`) for no cleanliness gain.
- The baseline was regenerated without type entries (40 unused exports remain grandfathered);
  `npm run check:code-health` passes.
