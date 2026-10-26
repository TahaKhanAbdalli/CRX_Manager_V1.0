## 2026-10-26 — Code-health ratchet: no new oversized, tangled, or unused code in src/

- New CI step `npm run check:code-health` (in the Lint, Type Check, Build job) runs
  `scripts/check-code-health.mjs`: ESLint size and complexity rules (file over 600 lines,
  function over 200 lines, complexity over 20, nesting over 4, more than 5 parameters, callbacks
  nested over 4) and Knip (unused files, exports, types, duplicate exports) over `src/`.
- Existing debt is grandfathered in `scripts/code-health-baseline.json` (509 size/complexity
  findings in 158 files; 1 unused file, 40 unused exports, 186 unused exported types at
  creation). Only new findings fail. `--update` shrinks the baseline after a cleanup and
  refuses while any regression remains; inline `eslint-disable` comments cannot hide a finding.
- Knip 5 added as a dev dependency; `knip.json` scopes it to the app.
- Proof: a probe file with a 6-parameter, complexity-21 function, an `eslint-disable` comment
  and no importer failed with all three findings and `--update` refused it; removed, the check
  passes. `node scripts/check-code-health.test.mjs` passes. Not verified: the step in GitHub CI.
