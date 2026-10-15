## 2026-10-15 — three intermittent Vitest failures fixed (tests only, no app change)

Three tests failed CI now and then on documentation-only PRs (#917, #923, #930) and passed on
re-run. Each now has a found cause and a fix that keeps what the test checks:

- **`Customers.filters.test.tsx` — "does not warn when the book is exactly the cap…"** timed out
  at 5s. No race: both cap tests must draw a real 1,000-row customer table (fewer rows could not
  tell the count-based check from the page-length fallback). That takes ~0.3s locally and ~10x
  that on a busy CI runner, and each whole-page `getByText`/`queryByText` search over it costs
  another ~0.1s. Both tests now wait until the table shows all 1,000 rows, read the truncation
  warning from the page text once, and get a 20s limit sized for the render.
- **`LoaderWorksheetsPanel.test.tsx` — "rejects manual load acres that would overfill a tank"**
  could not find its error message. The panel fills the load-acre boxes with the automatic split
  in an effect after they first render. Since the React 19 upgrade (#906) that effect can still
  be queued when the test starts typing, and when it lands late it overwrites the first value
  (reproduced locally under CPU load: 7 of 1,200 runs; after the fix 0 of 800). The three tests
  that type into those boxes now wait until the boxes hold their automatic values. The old wait
  in one of them (`not.toHaveValue('')`) never waited, because an empty number box reads as `null`.
- **`QuoteBuilder.test.tsx` — "sends the below-cost retry when the operator is still on the
  quote being approved"** saw one save instead of two. The below-cost dialog clears its reason box
  in an effect when it opens; landing after the typed reason, it wiped it, so Approve stayed
  disabled and no retry was sent (reproduced: 1 of 120 loaded runs; after the fix 0 of 240). The
  shared `approveBelowCost` helper now waits for focus to move inside the dialog (which happens
  only after that effect) and asserts Approve is enabled before clicking.
  `BelowCostApprovalContext.test.tsx` typed into the same dialog the same way and gets the same
  wait.

Each fix was checked by temporarily breaking the app behavior its test guards and confirming the
test then fails. The four changed files then passed repeated full runs three at a time on a loaded
machine, and the loader file passed 20 runs under `--coverage` (CI-style instrumentation). The pattern is recorded in `docs/reference/gotchas.md` › React & UI.
