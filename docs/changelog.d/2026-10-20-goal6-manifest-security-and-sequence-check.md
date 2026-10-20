## 2026-10-20 — Goal 6: restore checks cover security switches, grants and the next sequence number

Folded two review points deferred from PR #962 into both Goal 6 drafts
(`docs/plans/2026-10-19-goal6-backup-health-alert-design.md` and
`docs/plans/2026-10-19-goal6-restore-procedure-draft.md`):

- The independent schema comparison now also checks each table's row-level security switches
  (ENABLE and FORCE), the grants on tables, columns, sequences and functions, and the default privileges.
  Policy names alone prove nothing, because PostgreSQL keeps policies when row-level security is off
  (`supabase/baselines/README.md`).
- The sequence check now compares the number a sequence will hand out next (from `last_value`,
  `is_called` and the increment) with the highest number already stored, instead of requiring
  `last_value` itself to be higher, which would fail a correctly restored sequence.

Proof: documentation only. Not verified: nothing is built or run; the first restore drill proves these checks.
