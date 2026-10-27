## 2026-10-25 — Field tables follow field access (To-Do row 11.4, part B)

Part B of the row 11.4 fix plan in `docs/manual/KNOWN_ISSUES.md` (KI-01, KI-73). One new migration,
`20261026050000_field_tables_follow_field_access.sql` (migration-history row 985, not applied), a
checked-in disposable prover (`scripts/smoke/prove-field-tables-follow-field-access-real-schema.mjs`)
and its container chain (`scripts/smoke/smoke-field-tables-follow-field-access.sql`). No frontend file
changed. Mason decided the scope in the session: someone sent to a job sees the entire job, and jobs
they are not on stay hidden (`DECISION_LOG.md`, 2026-10-25).

### What was wrong

Part A (live 2026-10-25, 9:10 PM Central) fixed the field functions, but the tables themselves still
let field roles read everything: live, the one applicator read all 5 `fields` rows directly.
* Every active applicator read every customer's fields, boundary parts, crop history and obstacles,
  and every field-application invoice's locations and billed shares; and could add, rewrite or delete
  any field's boundary parts directly.
* Every active profile, drivers included, read every field's billing splits (with price overrides)
  and spray-record field rows.
* `get_job_billed_customers` checked who was asking with `IF NOT (...)`. On a job with no whole-job
  applicator the applicator part of that check is unknown (NULL), and `NOT` of unknown never refused,
  so any active applicator holding a job id got that job's billed customers (farm names, account
  numbers). Found by this part's prover; drivers were already refused.
* Part A showed a per-field assignee only the one field of their dispatch on the field maps, so on a
  split job their reports would have listed one field's acres beside the whole job's product totals.

### What changed

* `_can_see_field` (part A's helper): an assignee now sees every field of a job they are dispatched
  on, not only the field of their own dispatch row. The assignment window is unchanged.
* The field tables use it for applicators: `fields`, `field_crop_history`, `field_obstacles`,
  `field_billing_defaults` and `application_record_fields` (the last two were any active account).
  `field_polygons` reads follow `fields`. Drivers no longer read billing splits or spray-record fields.
* Office-only, because no field-role screen uses them: reading `field_app_locations` and
  `field_app_location_shares`, and writing `field_polygons` (the app writes boundary parts only
  through office-only functions).
* `get_job_billed_customers` now refuses a caller who cannot see the job (`IF (...) IS NOT TRUE`).
* The job pages (`job_fields`, the job map, the Dispatch Board, both billed-customer lookups) stay
  job-wide, so an assignee's reports cover the whole job.
* Expected narrowing: an applicator's Record Book shows "-" for the field name once that job's
  assignment ends, as it already does for the customer name after 7 days. A signed-out read of the
  `application_record_fields` table now errors instead of returning nothing (three other field tables
  already did).

### Not changed

What office staff see or write; every other write policy; `jobs_select` and the whole-job
applicator's job-level window (part C). No rows change.
