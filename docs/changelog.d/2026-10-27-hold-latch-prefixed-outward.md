## 2026-10-27 - Prefixed outward actions also latch

- From Luna round 34 on PR #1152: an outward-action word counts wherever it appears inside the word, so "the hook should stop force-pushing to main" and "make the job stop re-deploying" latch the hold.
