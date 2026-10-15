## 2026-10-14 — Goal 1: the RUP sales register is admin-only

First of the three Goal 1 security fixes (`docs/plans/2026-10-13-direction-and-goals.md`).

**The hole.** `get_rup_sales_register` ran with owner rights and had no caller check, so any
signed-in account (sales rep, driver, applicator, commission-recipient profile, or a deactivated
account whose access token had not yet expired) could pull every restricted-use sale with the
buyer's license number. Sales reps could also read the `rup_sales_records` table directly. The
register held 0 rows on 2026-10-14, so nothing had been exposed.

**The fix.**
- Migration `20261014220000_rup_register_admin_only.sql`: the function first calls
  `require_admin()` (active admin only); `rup_sales_select` becomes `is_admin()`; anon loses its
  unused table privileges. Posting invoices still writes register rows for reps (the writer is
  unchanged).
- `src/pages/Compliance.tsx`: the RUP Sales Register tab shows only for admins. Sales reps keep
  the Licenses, RUP Products and Field Listing tabs.
- Reference docs: `rpc-functions.md`, `database-schema.md` (RLS matrix), `pages-routes.md`,
  `migration-history.md`.

**Proof.** `scripts/smoke/prove-rup-register-admin-only-real-schema.mjs` builds the production
schema in a disposable database and runs 18 role cases before and after: before, every signed-in
role pulled the register; after, only the admin does, and the rep, deactivated rep, driver,
applicator, commission-recipient profile, deactivated admin and signed-out visitor are refused. It also proves the
preflight refuses a drifted body, the file re-applies cleanly, and the refusal comes from the
admin gate (mutation check). New live chain `scripts/smoke/smoke-rup_register_admin_only.sql`
(spec `get_rup_sales_register`) checks the same per role on live after apply, rolled back; it was
run against the disposable database first (PASS) and fails as intended with the gate disabled.

**Mason's decisions recorded with this goal (2026-10-14, in chat):** customer receipt emails carry
no delivery photos; applicators keep seeing a job's fields for 2 days after the job is done; sales
reps keep seeing cost and margin. These apply to the photo and cost/field fixes that follow.
