## 2026-10-23 — vendor-bill overage test types the reason until it sticks

- `src/pages/NewVendorBill.overage.test.tsx` ("prompts for a reason on an ordinary overage…") failed
  once in CI on 2026-10-23 (run 39958101798, `expected 1 to be greater than 1`). Cause: `ReasonModal`
  clears its reason in an effect when it opens. Under load that effect could still be pending when the
  prompt appeared, and it wiped the typed reason inside the same render, so the confirm click was
  refused as too short and no retry was sent. A temporary probe caught the wipe in 3 of 328 loaded
  runs. The test now re-types the reason until the box holds it, then clicks.
- Proof: 8 parallel runs × 41 repeats under load — the old test failed in 3 of 8 batches with the
  CI error; the fixed test passed all 8. Test-only; no app behaviour changes (a person cannot type
  before the dialog finishes opening).
