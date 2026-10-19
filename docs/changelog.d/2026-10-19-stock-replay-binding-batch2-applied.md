## 2026-10-19 — Replay-binding batch 2 (stock) is live

- **Applied.** `20261016140000_bind_stock_replay_receipts_batch2` applied live 2026-10-19 01:03 UTC
  (ledger `20261019010324`) on Mason's owner approval; PR #951 merged as `d51d67c0b`. The thirteen
  stock RPCs now replay a saved result only for the same person and the exact same request; a
  changed request or another person's retry key is refused.
- **Proof.** The migration's in-transaction postflight passed, and a read-only check after the
  apply found one SECURITY DEFINER wrapper per public name (callable by signed-in users, not
  anonymously), each renamed body private, the commit-time guard covering both batches, and
  `revert_quote_status` refusing a keyless call. The rollback-only smoke chains were not run live,
  because the LIVE-DATA guard refuses their test-record inserts without owner REAL-DATA-OK; their
  container proofs passed before the apply.
- **Sweeps.** Read-only invariant sweeps after the apply: 27 of 29 PASS with no row from batch 2.
  `quote-versions-rpc-owned` was declined (not run). `actor-forgery`, which used to time out, now
  completes and flags one batch-1 row (`apply_prepay_to_invoice`, its keyless internal-batch branch),
  recorded as OPEN in KNOWN_ISSUES.
- **Docs.** Migration history row 952, KNOWN_ISSUES (replay-binding entry, 74 functions left, the stock row removed from its table),
  CURRENT_STATE (high-water) and the schema registry's `migrations_high_water` now read applied.
