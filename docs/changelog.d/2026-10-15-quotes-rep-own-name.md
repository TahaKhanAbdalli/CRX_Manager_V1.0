## 2026-10-15 — Quotes: a sales rep records only their own name as salesperson; season rollover keeps the original rep

Migration `20261015200000_quotes_rep_own_name` (migration-history row 948; not applied when written).

- New trigger `quotes_guard_rep_salesman_20261015` (function `guard_rep_quote_salesman_20261015`,
  runs with the caller's rights, callable by no API role), BEFORE INSERT OR UPDATE OF `salesman_id`
  on `quotes`: an active sales rep who is not an admin names only themselves or no one, and changes
  a salesperson only from blank to themselves (`SALESMAN_SCOPE_DENIED`). An update that leaves the
  salesperson alone is never refused. Admins are unrestricted.
- `rollover_quote_to_season` is its verbatim live body plus two `set_config` lines and a comment: it marks its own insert with
  the transaction-local setting `crx.quote_rollover_source` = the source quote, and clears it
  afterwards. The guard accepts another person's name only under that marker and only when it is
  the source quote's salesperson, so a rep rolling over another rep's quote keeps that rep.

**Why.** Mason, 2026-10-15: "Yes — quotes follow the own-name rule. On season rollover, keep the
original rep on the new quote." This closes `KNOWN_ISSUES.md` "Quote salesperson" once applied.

**Impact today.** None on screens: no screen writes `quotes.salesman_id`, and all 4 live quotes have
it blank (read-only, 2026-10-15).

**Proof.** `node scripts/smoke/prove-quotes-rep-own-name-real-schema.mjs` prints
`QUOTES_OWN_NAME_PROOF_PASS` (disposable PostgreSQL 17: replayed bodies match the live pins, the new
chain fails first before and passes after, two covering chains pass before and after,
autocommit, drift, marker-in-use and re-apply refusals, seven hunk mutations).
