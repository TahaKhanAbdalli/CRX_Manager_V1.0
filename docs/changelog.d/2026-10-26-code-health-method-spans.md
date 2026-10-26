## 2026-10-26 — Code-health findings on methods keep the method's name

- `scripts/check-code-health-lib.mjs` now starts a method's span at its name. ESLint reports
  shorthand object methods, getters, and class methods (`save() {}`) at the name, which sits
  before the function itself, so those findings were credited to the enclosing function and a
  new method could use up an unrelated grandfathered allowance (Codex GitHub App P2 on #1117).
- Baseline regenerated: 7 existing `action() {}` findings moved from their outer handler to
  `<handler> > action`; no allowance grew.
- Proof: `node scripts/check-code-health.test.mjs` lints real code with ESLint's `Linter` and
  asserts each method keeps its own key; with the fix reverted the test fails (all four collapse
  into `complexity App`). `npm run check:code-health` passes.
