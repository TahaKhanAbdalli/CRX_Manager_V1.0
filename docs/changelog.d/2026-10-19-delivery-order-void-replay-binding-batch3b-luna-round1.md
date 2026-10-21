## 2026-10-19 — replay-binding batch 3b: Codex Luna round 1 fixes (not yet applied)

**Codex Luna round 1 (2 findings):**
- **HIGH, fixed: voiding an order with a draft invoice always failed.** `void_order` marks the order
  voided first, then cancels the order's draft invoices by status alone. A safety trigger refuses
  that on a voided order unless the draft's money fields are zero, so the whole void rolled back
  with `ORDER_INVOICE_TERMINAL`. Six live fulfilled orders had such a draft (read 2026-10-19); no order
  has ever been voided live, so nobody hit it yet. The migration now makes the same edit
  `cancel_order` already has: that cancel also sets total, paid, prepay and write-off cents to zero
  (a never-posted draft has no financial impact; the audit row keeps its original total). It is
  applied by exact text substitution on the md5-pinned live body. The smoke chain now voids an
  order with a real draft invoice and checks it ends cancelled at zero; the prover shows the chain
  fails with the live error when the fix is taken out.
- **MED, fixed:** the check for other database code calling these three functions now scans every
  schema (not only `public`), ignores letter case, accepts quoted names, and also checks scheduled
  jobs. A name built at run time cannot be seen; such a caller would be refused with nothing saved.
