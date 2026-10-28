## 2026-10-27 — Records: stale sweep fingerprints after the sent-quote price lock deferred (KI-85, To-Do 11.12)

- The post-apply db-invariant sweeps after PR #1119 (29 predicates, `complete: true`) returned 4 unallowlisted rows,
  all from functions `20261027040000_quote_sent_price_lock` (PR #1105) re-emitted without re-pinning:
  `actor-forgery` on `save_quote` and `convert_quote_to_order`, and `quote-versions-rpc-owned` on
  `_create_quote_version_owner_impl` and `_restore_quote_version_owner_impl`. None touches PR #1119's objects.
- Mason, 2026-10-27: recorded, not fixed now. `docs/manual/KNOWN_ISSUES.md` adds KI-85 (MED, open; summary count 52)
  and `docs/manual/TO_DO_LIST.md` adds row 11.12 (SHOULD). Until fixed, every post-apply sweep shows these same 4 rows.
