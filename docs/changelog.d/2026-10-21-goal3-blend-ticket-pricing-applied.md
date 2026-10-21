## 2026-10-21 — Goal 3 blend-ticket pricing is live

- Migration `20261020210000_blend_ticket_pricing_guards` was applied live at 2026-10-21 04:00:52 UTC
  (ledger version `20261021040052`) under the autonomous-landing rule, and PR #982 merged as
  `948f238ad` right after.
- Live read-only check: only the 4-argument `create_invoice_from_blend_ticket` remains, it and
  `set_blend_ticket_product_quote_price` run for signed-in users and not for anonymous visitors, and
  `below_cost_approvals_operation_check` accepts `create_invoice_from_blend_ticket`.
- Records updated: `docs/reference/migration-history.md` row 958, `docs/manual/CURRENT_STATE.md`,
  `docs/manual/KNOWN_ISSUES.md`, and the Goal 3 Pricing bullet in the direction-and-goals plan.
- Still owed: regenerate `.claude/schema-registry.json` (`below_cost_approvals.operation` gained a value).
