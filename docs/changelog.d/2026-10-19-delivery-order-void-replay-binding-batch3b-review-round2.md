## 2026-10-19 — replay-binding batch 3b: review round 2 fixes (not yet applied)

- **void_order's inner body is now written out in full in the migration** (Codex GitHub review,
  P1). The draft-invoice fix had been installed by a statement built at run time, which hid the
  new body of a money function from the repository's migration scanners. The migration now spells
  out the whole body: the md5-pinned live body (taken byte-for-byte from
  `20260620130000_commission_batch_freeze_guard.sql`, whose body matches the live md5) plus only
  the four zeroing lines. The preflight still pins the live body, and the postflight still proves
  that removing those four lines gives back the pinned md5. The idempotency-scope registry records
  that this private body keeps the public `void_order` operation name on purpose.
- The call-site test now proves each delivery RPC call sits inside the handler's own `try` block,
  not just after some earlier `try` (CodeRabbit).
