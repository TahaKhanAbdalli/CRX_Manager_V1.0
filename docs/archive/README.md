# Archive

The 2026-10-28 docs cleanup removed most of this folder. These eight files stay because an
applied database migration, an agent instruction, or the migration ledger
(`docs/reference/migration-history.md`) names them, and those must not be edited.

⚠️ Statuses inside these files are frozen at their last edit. Verify current behavior in code
and the live database before acting on anything here.

| File | Named by |
|---|---|
| `2026-spring/2026-05-09-execution-summary.md` | Migration `20260511010000_actor_spoof_cleanup.sql`; migration ledger |
| `2026-spring/2026-05-12-execution-summary.md` | Migration ledger |
| `2026-spring/2026-05-13-pr59-codex-review-summary.md` | Migration ledger |
| `2026-spring/2026-05-26-claude-disposition-of-codex-execution.md` | Three May migrations; the RLS security reviewer agent |
| `2026-spring/2026-05-29-codex-disposition.md` | Migration `20260529214355`; migration ledger |
| `2026-spring/2026-05-31-codex-review-verification-and-followup.md` | Migration `20260531151134_batch_rpc_strict_actor.sql`; migration ledger |
| `2026-spring/claude-md-session-log-pre-2026-06-15.md` | `docs/audits/foundation-ultra-review-prompt.md` (an agent prompt) |
| `2026-summer-closeout/roadmap/product-units-scheduling-deep-dive-2026-07-01.md` | Migration `20260704120000_a5_blend_ticket_unit_conversion.sql` |

Everything else that was here is listed, with restore steps, in
`docs/audits/2026-10-28-removed-finished-docs.md`.
