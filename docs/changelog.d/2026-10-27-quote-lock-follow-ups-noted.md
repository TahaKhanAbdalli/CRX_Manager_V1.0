## 2026-10-27 — Known Issues: two follow-ups from the quote sent-price lock (PR #1105)

- KI-82 (LOW, money display only): after Save, the open quote screen does not load a new line's recorded cost, so
  an admin can see a stale Cost/Profit/Margin until reload (Sol review of #1105).
- KI-83 (LOW, database): `idempotency_keys` has no interface in `src/types/index.ts` (the generated
  `src/types/supabase.ts` has it), so the migration review's TypeScript
  cross-check cannot confirm writes to it (migration-drift review of `20261027040000`; the gap predates it).
- KI-81 (blend-ticket and field-application invoices read the live quote price) stays open, marked by Mason on
  2026-10-27: fix later, not now.
- Summary count of open entries 49 → 51.
