## 2026-10-21 — blend-ticket $0-approval test no longer times out on a busy CI runner

- `src/pages/BlendTicketDetail.test.tsx` "asks an admin to approve a $0 quoted line with a reason,
  then bills with that reason" sometimes failed CI with "Test timed out in 5000ms" (5,026 ms in run
  39610071373 while its neighbours took 100–500 ms). It was not slow; it was stuck. The below-cost
  approval window clears its reason box in an effect that runs just after it appears; on a busy
  runner that effect could land after the test typed the reason, wiping it, so Approve stayed
  disabled and the click did nothing.
- The test now waits for the window to move focus inside itself (done in that same effect pass)
  before typing, and checks Approve is enabled before clicking, so a regression fails at once with a
  clear message instead of a 5 s hang, the same fix `QuoteBuilder.test.tsx` got for this race in
  PR #930. Reproduced locally by delaying React's scheduler 5 ms: 0/3 passed before the change, 5/5
  after. On a quiet machine the file passes 10/10 both ways; the test takes 53–141 ms (avg 77)
  before and 126–200 ms (avg 157) after, the extra being one frame of waiting for focus.
  Test-only; no app behaviour changes.
