## 2026-10-14 - 6e covers only the New Invoice page, not field-application invoices

Documentation only; no app or database change.

- Mason's 6e decision ("confirm 6e") was explained to him as the New Invoice page: from-scratch `misc_charge` invoices carry no product lines. As merged in PR #911, the wording said "no order, no delivery", which would also catch field-application invoices. Codex flagged this on #911 just before it merged.
- Field-application invoices have no order by design: direct field-app, blend-ticket and completed-job invoices (`invoices_field_application_has_no_order`; `docs/workflows/QUOTE_TO_DELIVERY.md`).
- `docs/plans/2026-10-13-direction-and-goals.md` and `docs/manual/KNOWN_ISSUES.md` now limit 6e to `misc_charge` and `chemical_sale` invoices with no order or delivery behind them (the New Invoice page's two types). Excluded: field-application invoices (`invoice_type = 'field_application'`: direct field-app, blend-ticket and job invoices), which keep their chemical lines, and credit memos (return credits). Goal 3 caps job and blend-ticket invoices at the quantity applied on their source, summed across split siblings, and treats a direct field-app entry as its own application record.
- For the 6g "bill only when delivered" rule, chemicals applied on a field application count as delivered.
- `docs/manual/DECISION_LOG.md` gets a new clarification entry on top. The original 6e and 6g entries stay unchanged, because the log never rewrites past entries.
