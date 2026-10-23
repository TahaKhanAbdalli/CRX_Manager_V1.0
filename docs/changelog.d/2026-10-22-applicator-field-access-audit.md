## 2026-10-22 — To-Do List row 11.4: applicator field access audited; it fails today

- A read-only live audit of row 11.4 (an applicator sees only their assigned fields and loses them when the assignment
  ends) found three HIGH and two MED problems. The worst: seven field functions with no access check give every field,
  field boundary and owner name to any signed-in account, drivers included, and four more hand out
  customer balances and overdue invoices. Each HIGH was proven by read-only impersonation on live.
- `docs/manual/KNOWN_ISSUES.md` has the findings and a three-part fix plan (gate the functions, narrow the field tables,
  end the whole-job route like the dispatch route). The carried-over LOW about `fields_select` now points to it.
- `docs/manual/TO_DO_LIST.md` row 11.4 now reads "Fails today" instead of "Not proven".
- Documentation only. No fix is built: each part is a migration.
