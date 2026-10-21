## 2026-10-21 — Carry-forward test no longer fails once the real clock passes its pinned time

Main went red at 18:00 UTC (1pm Central) on 2026-10-21: the guard test
"carry: a carried proof can itself be carried" in
`scripts/write-codex-push-proof.test.mjs` pins `nowMs` to that moment, but built
its carried proof with `buildCarryForwardProof()`'s default real-clock
timestamp. Once the wall clock passed the pinned time, the carried proof was
dated after `nowMs`, and the age check refused it (as "older than 24 hours",
the same message it uses for a future-dated proof). That failure also fails the
required "Lint, Type Check, Test, Build" job, so no PR could merge.

- `scripts/write-codex-push-proof.test.mjs`: the carried proof is now dated 30
  seconds before the pinned clock. The check itself is unchanged.
- Proof: the test failed on main `e8ca799a3` locally and passes after the fix;
  `npm run test:agent-workflows` passes.

Test-only; no app code, no database change.
