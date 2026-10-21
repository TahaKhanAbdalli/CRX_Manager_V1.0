## 2026-10-21 — CI runs its slow checks side by side

- Measured on the last 40 green pull-request runs: median 17.3 min from push to the last check,
  almost all of it execution (median wait for the first runner 0.3 min). The required job ran
  ESLint, type check, guard tests, Phase 3C tests, Vitest with coverage, and the build one after
  another (median 13.9 min) and started only after SQL validation; the Windows job ran its two
  suites back to back (median 11.8 min).
- `ci.yml` now runs `lint-typecheck-build`, `unit-tests`, and `regression-tests` in parallel with
  `sql-validation`, and splits Windows into `phase3c-containment-windows` and
  `guard-hooks-windows`. Every test and check still runs; no skip rule was added.
- The required check keeps its name, "Lint, Type Check, Test, Build". It now runs last, is red
  unless containment, routing, SQL validation, every Ubuntu part, and both Windows jobs passed
  (test and Windows jobs may be skipped only on the documentation-only route), and alone
  publishes the full-CI proof. Binding the Windows jobs is new: before, a red Windows job did not
  turn the required check red (the agent merge gate still blocked on it).
- `scripts/classify-ci-scope.test.mjs` and `scripts/supplier-pricing-phase3-private-artifacts.test.mjs`
  assert the new job graph.
