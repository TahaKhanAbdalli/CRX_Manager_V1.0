## 2026-10-26 — quote-versions sweep watches the whole SELECT policy set (review round 3)

- New `quote_versions:extra-select-policy` branch fires on any SELECT policy other than `qversions_select`:
  a second permissive one widens who can read version history, a restrictive one can empty it.
- The `qversions_select` role test now uses `pg_has_role(..., 'USAGE')`, which follows inherited privileges
  the way row security does; `'MEMBER'` also accepted NOINHERIT memberships that never apply.
- `get_quote_versions:contract-pinned` also pins `proargnames`: the browser calls it with `p_quote_id` and
  reads its columns by name.
- Live read-only check 2026-10-26: none of these fire.
