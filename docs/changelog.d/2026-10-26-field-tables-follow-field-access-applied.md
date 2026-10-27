## 2026-10-26 — Field tables follow field access, applied live (To-Do row 11.4 part B, PR #1103)

**What changed.** Migration `20261026050000_field_tables_follow_field_access` (row 985) was applied live on
2026-10-27 at 02:05:46 UTC (9:05 PM Central on 2026-10-26) through `scripts/apply-migration-file.mjs`, on Mason's
own `I approve` (owner-approval reference 329279), before PR #1103 merged at 02:06:18 UTC (9:06 PM Central) as
`5d8af90c1` from head `5ecf4b4aa`; ledger version `20261027020546`. CodeRabbit was waived by Mason ("skip
coderabbit 1103"); Sol was clean on the exact head; both apply proofs were clean. Field staff now read, through the
field tables too, only the fields of the jobs they are sent to (the whole job), and drivers no longer read billing
splits or spray-record field rows.

**Proof.** Read-only live checks after the apply: `_can_see_field` body md5 `32cf69a9a79a6d62a9ba255777de199a`,
matching the migration's postflight pin; `fields_select` and `field_obstacles_select` (and, per the file,
`field_crop_history_select`, `fbd_select`, `arf_select`) gate applicators on `_can_see_field`;
`field_app_locations_select` and `field_app_location_shares_select` are office-only. Visible `fields` rows per role,
computed read-only from the live policy rules with each active person's id substituted (live impersonation is
blocked by the live-data guard, so this is an equivalent computation, not a signed-in test): admins (4) 5 of 5,
sales reps (3) 5 of 5, the 1 active applicator 2 of 5 (the fields of the jobs they are dispatched to), drivers (2)
0, entity recipients (2) 0. The ledger has 1065 rows.

**Docs.** `migration-history.md` row 985 and live capture, `CURRENT_STATE.md`, `KNOWN_ISSUES.md` KI-01 and KI-73,
`TO_DO_LIST.md` row 11.4, and `rpc-functions.md`.

**Still owed.** Part C (access does not end when the assignment ends; no PR) and an in-app click-through as an
applicator.
