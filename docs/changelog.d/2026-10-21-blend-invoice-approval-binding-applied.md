## 2026-10-21 — schema registry refreshed after the blend invoice approval binding went live

`20261021070000_blend_invoice_approval_binding` (PR #995) was applied live at 20:41:00 UTC
(3:41 PM Central; ledger version `20261021204100`) before PR #995 merged as `a254cbfcf`; its
migration-history row 961 and the manual re-stamps landed with PR #1011's 20:44 UTC read.

`.claude/schema-registry.json` regenerated from live introspection (2026-10-21 ~20:50 UTC, all six queries):
high-water `20261021204100`, the four 2026-10-20/21 migrations added to the applied names, and
`below_cost_approvals.operation` now lists `create_invoice_from_blend_ticket` (added live by
`20261020210000`). Section counts are unchanged (38 status lists, 120 parsed checks).
