## 2026-10-25 — Field functions require field access, applied live (To-Do row 11.4 part A, PR #1065)

**What changed.** Migration `20261023090000_field_functions_require_field_access` (row 980) was applied live on
2026-10-26 at 02:10:16 UTC (9:10 PM Central on 2026-10-25) on Mason's own `I approve`, before PR #1065 merged as
`9ad2cb000`; ledger version `20261026021016`. The field-map and office database functions now check who is
asking: the field-map lookup returns only the fields a person may see (office staff every field; a whole-job
applicator the fields on their non-deleted job; anyone else only the field their own dispatch or crew dispatch
points at, while it is open or completed within 7 days); the all-fields map, field dashboards, billing splits,
balances, credit checks, the action queue and global search are office-only; and a record's notes follow the
record. Office staff are unchanged except that a sales rep no longer gets notes on another rep's invoice (no
screen shows invoice notes).

**Proof.** Read-only `execute_sql` after the apply: `_can_see_field` exists (SECURITY DEFINER, STABLE,
`search_path=public, pg_temp`, no `anon`); `get_notes_for_entity` runs as the caller; impersonated counts show
the real applicator gets 2 fields (its 2 open dispatches; it was 5) and is refused the all-fields map, the driver
tested gets 0 and an admin all 5. Ledger 1061 rows / 1054 names, effective high-water `20261023090000`. The schema
registry's six sections were fingerprint-matched against live; only the high-water and the new name changed, as
expected for a functions-only migration. `src/types/supabase.ts` gains only `_can_see_field`, taken verbatim from a
live type generation; the other 18 functions the migration touched generate exactly as they are checked in. The
whole generated file was not adopted: it drops hand-kept entries (the `invoice_postable_version` computed field on
`invoices_postable`, nullable report columns such as `get_quote_versions`), which breaks the typecheck (KI-52).
The live function snapshot in `src/lib/rpcFixtureLiveDiff.test.ts` was re-read from live in
full: 731 distinct names, a strict superset of the old 671-name snapshot (60 functions added since 2026-10-15:
59 internal helpers, `_can_see_field` among them, plus the `invoice_postable_version` computed field; none removed).

**Docs.** `migration-history.md` row 980 and live capture, `CURRENT_STATE.md`, `KNOWN_ISSUES.md` KI-01 and KI-73
(now PARTIAL: part A applied, parts B and C open) and a new LOW under KI-07 (12 SECURITY DEFINER field functions
use `search_path` `public, extensions, pg_temp`, which the written rule does not cover; promised to CodeRabbit on
PR #1065), a KI-52 note that the types file cannot be swapped wholesale for a live generation, and
`TO_DO_LIST.md` row 11.4.

**Still owed.** Part B (applicators still read all 5 `fields` rows directly) and part C (the whole-job applicator
route has no end); an in-app click-through as an applicator.
