## 2026-10-25 — Invoice PDF line-read guard on the list, email and batch paths (B3 follow-up)

PR #1085 stopped single-invoice Print/Email on `InvoiceDetail` from making a PDF with no lines
under a stored total. The same defect remained on every other invoice PDF path; this closes it.

- **One shared check.** `assertInvoiceLinesLoaded()` (`src/lib/invoicePdf.ts`) refuses a PDF when
  the `invoice_items` read fails, or returns no lines while the printed total is not $0 (a
  negative credit total counts). Each path passes the same total its PDF prints.
  `InvoiceDetail`'s own copy from #1085 now calls it too. `buildInvoicePdfDataFromRow` calls it,
  which covers per-row Print, Old Print and Email on the field-invoice lists and Print and Email
  from the field-invoice editor.
- **Batches skip and name.** `buildBatchInvoicePdfData()` builds each invoice's PDF data five at
  a time, in order (batch print on Invoices used to go one at a time; field-invoice Print All
  used to start every invoice at once). It skips any invoice whose lines could not be read
  (reported to Sentry as a warning), and the batch prints the rest with a warning toast naming
  the skipped invoices. If every invoice is skipped, nothing prints and the error names them.
  Used by batch Print on Invoices and Print All / Old Print All on the field-invoice Drafts,
  Posted and All Invoices tabs.
- **Honest batch count.** `generateBatchInvoicePdf` now returns `{ doc, failures }`. The toast
  counts only the PDFs that downloaded and names any that failed to build. A toast lists the
  first five invoice numbers, then "and N more".
- **A one-invoice batch now downloads.** `generateBatchInvoicePdf` returned a single invoice's
  PDF without saving it, so batch-printing exactly one invoice showed "Printed" but downloaded
  nothing. A batch that drops to one after a skip hit the same gap; it now saves.

**Live check (read-only, 2026-10-25).** No undeleted invoice has a non-zero total and no lines,
so the check makes no existing invoice unprintable.

**Proof.** Local app against a local fake database (no live data). Invoices batch print with one
invoice's line read failing downloaded only the good invoice and named the bad one; with every
read empty it downloaded nothing and named both; with no failure it downloaded both. On Field
Invoices (Drafts and All Invoices tabs), Print All skipped and named the bad invoice and printed
the good one; per-row Print and Email of the bad invoice were refused (no download, no email
sent); per-row Print of the good invoice downloaded.

**Not verified in the browser.** The Posted tab's Print All (the fake database had no posted
invoices) and Print/Email from the field-invoice editor; both run the same shared code proven
above.
