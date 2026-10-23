## 2026-10-21 — vendor-bill overage tests get a 30 s per-test ceiling

- `src/pages/NewVendorBill.overage.test.tsx` still flaked after the 5 s wait from #994: the whole test
  was capped at Vitest's 5 s default, so a longer inner wait could not help. The ordinary-overage case
  timed out at 5000 ms under CI coverage load on PR #1017 (run 39692337251). The test group now has a
  30 s per-test timeout (`describe(..., { timeout: 30_000 })`, the pattern
  `commissionPayoutGuards.test.ts` uses). No assertion changed. A temporary 6 s probe test in the
  group passed with the option and failed at 5004 ms without it. Test-only; no app behaviour changes.
