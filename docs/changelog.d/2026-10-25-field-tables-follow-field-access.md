## 2026-10-25 — Field tables follow field access (To-Do row 11.4, part B)

Part B of the row 11.4 fix plan in `docs/manual/KNOWN_ISSUES.md` (KI-01, KI-73). One new migration,
`20261023110000_field_tables_follow_field_access.sql` (migration-history row 983, not applied), a
checked-in disposable prover (`scripts/smoke/prove-field-tables-follow-field-access-real-schema.mjs`)
and its container chain (`scripts/smoke/smoke-field-tables-follow-field-access.sql`). No frontend file
changed.

### What was wrong

Part A (live 2026-10-25, 9:10 PM Central) fixed the field functions, but the tables themselves still let field roles
read everything: live, the one applicator read all 5 `fields` rows directly while the map functions
gave it only its 2 dispatched fields. Every active applicator read every customer's fields, boundary
parts, crop history, obstacles and field-application locations and shares; every active profile,
drivers included, read every field's billing splits (with price overrides) and spray-record field
rows; and someone sent to one field of a split job read the job's other fields through `job_fields`,
the job map, the Dispatch Board and both billed-customer lookups.

### What changed

* Each of those reads keeps its office legs and uses part A's `_can_see_field(field_id)` for field
  roles: `fields_select`, `field_crop_history_select`, `field_obstacles_select`,
  `field_app_locations_select` and `field_app_location_shares_select` (applicator leg), `fbd_select`
  and `arf_select` (were any active profile), and `job_fields_select_location_dispatchee`.
  `field_polygons` follows `fields_select`.
* `get_job_fields_with_geojson`, `get_dispatch_board_jobs`, `get_job_billed_customers` and
  `get_jobs_billed_customers` return only the fields the caller may see. Their "a job with no fields
  still has its primary customer" fallback now asks about the job's fields, so a caller who sees none
  gets no rows (the compliance PDF refuses), never a primary-only list.
* `get_job_billed_customers` now refuses a caller who cannot see the job. Its check was written
  `IF NOT (...)`; on a job with no whole-job applicator the applicator part of it is unknown (NULL),
  and `NOT` of unknown never refused, so any active applicator holding a job id got that job's billed
  customers (farm names, account numbers). Found by this part's prover; drivers were already refused.
* Closes the Job Detail weather-centroid edge part A left: an assignee's first `job_fields` row is now
  their own field.
* Expected narrowing: an applicator's Record Book shows "-" for the field name once the assignment
  for that field ends, as it already does for the customer name after 7 days.

### Not changed

What office staff see; every write policy; `jobs_select` and the whole-job applicator's job-level
window (part C); `_can_see_field`. No rows change.
