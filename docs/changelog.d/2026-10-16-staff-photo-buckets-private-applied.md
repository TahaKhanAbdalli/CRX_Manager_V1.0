## 2026-10-16 — Staff photo buckets are private; records updated (migration `20261016030000`)

**Why.** PR #947 shipped `20261016030000_staff_photo_buckets_private` with migration-history row 950
still reading "not applied". It applied live at 05:19:44 UTC (ledger `20261016051944`) on Mason's
approval. A parallel session already updated the CURRENT_STATE and KNOWN_ISSUES headers; this change
finishes the record.

**What changed.**
- `docs/reference/migration-history.md`: new live ledger capture (2026-10-16 13:07 UTC: 1033 rows /
  1026 names, `max(version)` `20261016121253`, effective high-water `20261016060000`, applied by
  another session). Row 950 now reads APPLIED LIVE with its post-apply checks; the old text stays as
  the pre-apply record. Row 951 (`20261016060000`) now reads APPLIED LIVE from the ledger; its
  post-apply behaviour checks are left to that change's follow-up.
- `docs/manual/KNOWN_ISSUES.md`: the replay-binding entry says batch 1 is applied and moves its nine functions out of the unbound table (CodeRabbit on this PR); the duplicate team-note photo fix is applied, and Mason's
  signed-in check (2026-10-16: a delivery photo still shows in the app) is recorded.
- `docs/manual/CURRENT_STATE.md`: ledger header, effective high-water (now `20261016060000`), applied list
  and schema-registry line, all from the 13:07 UTC read (Codex on this PR).
- `.claude/schema-registry.json`: delta only (both applied names and `migrations_high_water`
  `20261016121253`), so the applied money migration is protected from edits (Codex on this PR).
- `src/lib/rpcContracts.test.ts`: prunes the `_bind_replay_receipt_20261015` inventory exemption,
  which goes stale once `20261016060000` is at or below the high-water (the same pruning as earlier
  applied trigger helpers).

**Still open.** The live chain `scripts/smoke/smoke-staff_photo_storage_access.sql` waits on Mason's
REAL-DATA-OK marker.
