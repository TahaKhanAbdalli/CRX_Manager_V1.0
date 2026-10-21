## 2026-10-21 — Goal 3 "invoices made from scratch take charge lines only" is live

- Migration `20261021050000_from_scratch_invoices_charge_lines_only` was applied live at 20:05:26 UTC (3:05 PM Central),
  ledger version `20261021200526`, under the autonomous-landing rule, and PR #983 merged as `454ae3831` right after.
- A read-only live check after the apply found the new `invoice_items.charge_type` column, both validated CHECKs, the three
  triggers, the updated `save_invoice` writer, and no active from-scratch invoice or line that breaks the rule.
- `migration-history.md` row 960 is marked applied; the `KNOWN_ISSUES.md` entry "an invoice made from scratch can name any
  product and quantity" is closed; the manual's ledger stamps record the 20:06 UTC read.
- Still owed: Mason's click-through of the New Invoice page's charge lines on the live site. The `save_invoice` smoke spec is
  container-only (it seeds fixtures the live-data guard refuses), so the live check was read-only.
