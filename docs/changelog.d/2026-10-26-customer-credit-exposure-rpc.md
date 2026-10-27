## 2026-10-26 — New read-only `customer_credit_exposure` RPC (migration 20261027030000, not applied)

- New database function `customer_credit_exposure(p_customer_id)` returns a customer's credit
  limit and whole open exposure in exact bigint cents: every rep's draft, unposted, posted and
  overdue invoice balances (negative balances count as 0; deleted, paid, voided and cancelled
  invoices are not counted). Admins and active sales reps only; an unknown customer is refused
  (`CUSTOMER_NOT_FOUND`), never answered with 0. A limit of 0 or less (the column's default, which
  every existing check reads as "no limit") comes back as null, so the caller cannot mistake it for a $0 limit.
- Why: PR #1132's credit-limit check read drafts through the browser, and invoice security lets a
  sales rep see only their own invoices, so rep B's check missed rep A's $9,000 draft for the same
  customer. This function reads all of them on the server. #1132 switches to it after this lands;
  nothing in the app calls it yet, and no existing function changes.
- Proof: `scripts/smoke/prove-customer-credit-exposure-real-schema.mjs` (disposable database,
  before/after, browser roles) and the rollback-only chain `scripts/smoke/smoke-customer-credit-exposure.sql`.
- Docs: `docs/reference/rpc-functions.md`, `docs/reference/migration-history.md` row 991; type
  `CustomerCreditExposure` in `src/types/index.ts`.
