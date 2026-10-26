## 2026-10-25 — Field tables follow field access (To-Do row 11.4, part B)

Part B of the row 11.4 fix plan in `docs/manual/KNOWN_ISSUES.md` (KI-01, KI-73). One new migration,
`20261023110000_field_tables_follow_field_access.sql` (migration-history row 983, not applied), a
checked-in disposable prover (`scripts/smoke/prove-field-tables-follow-field-access-real-schema.mjs`)
and its container chain (`scripts/smoke/smoke-field-tables-follow-field-access.sql`). No frontend file
changed.

### What was wrong

Part A (live 2026-10-25, 9:10 PM Central) fixed the field functions, but the tables themselves still
let field roles read everything: live, the one applicator read all 5 `fields` rows directly while the
map functions gave it only its 2 dispatched fields.
* Every active applicator read every customer's fields, boundary parts, crop history and obstacles,
  and every field-application invoice's locations and billed shares; and could add, rewrite or delete
  any field's boundary parts directly.
* Every active profile, drivers included, read every field's billing splits (with price overrides)
  and spray-record field rows.
* Someone sent to one field of a split job read the job's other fields through `job_fields`, the job
  map, the Dispatch Board and both billed-customer lookups.
* `get_job_billed_customers` checked who was asking with `IF NOT (...)`. On a job with no whole-job
  applicator the applicator part of that check is unknown (NULL), and `NOT` of unknown never refused,
  so any active applicator holding a job id got that job's billed customers (farm names, account
  numbers). Found by this part's prover; drivers were already refused.

### What changed

* The field tables use part A's `_can_see_field(field_id)` for field roles: `fields`,
  `field_crop_history` and `field_obstacles` (applicator leg), `field_billing_defaults` and
  `application_record_fields` (were any active profile). `field_polygons` reads follow `fields`.
* Office-only, because no field-role screen uses them: reading `field_app_locations` and
  `field_app_location_shares`, and writing `field_polygons` (the app writes boundary parts only
  through office-only functions).
* New `_can_see_job_field(job_id, field_id)`: the same rule tied to one job, used by the `job_fields`
  dispatchee policy, `get_job_fields_with_geojson`, `get_dispatch_board_jobs` and both billed-customer
  functions, so a job shows an assignee only the field they were sent to on that job (never one they
  were sent to on another job).
* In both billed-customer functions the "a job with no fields still has its primary customer"
  fallback now asks about the job's fields, so a caller who sees none of them gets no rows instead of a
  primary-only list: the compliance PDF refuses, and the Jobs list shows no billed customer.
* `get_job_billed_customers` now refuses a caller who cannot see the job (`IF (...) IS NOT TRUE`).
* Closes the Job Detail weather-centroid edge part A left: an assignee's first `job_fields` row is now
  their own field.
* Expected narrowing: an applicator's Record Book shows "-" for the field name once the assignment
  for that field ends, as it already does for the customer name after 7 days. A signed-out read of
  the four `TO public` tables now errors instead of returning nothing.

### Not changed

What office staff see or write; every other write policy; `jobs_select` and the whole-job
applicator's job-level window (part C); `_can_see_field`. No rows change.
