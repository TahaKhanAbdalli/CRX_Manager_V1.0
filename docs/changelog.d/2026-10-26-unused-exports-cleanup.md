## 2026-10-26 — Code-health ratchet: 21 grandfathered unused exports removed

- 21 names that Knip reported as exported but never imported by another file lost their
  `export` keyword (19 files under `src/`). Each one is still used inside its own file, so no
  logic changed; the names are just no longer public. Same-named items elsewhere
  (`.claude/hooks/*` `dollarTagAt`, `LabelDataQuality.tsx`'s own `isEpaLookupResult`, migration
  comments naming `completedAtForDeliveredOn`) are separate copies and were not touched.
- `scripts/code-health-baseline.json`'s `unused` section shrank from 40 entries to 19 via
  `node scripts/check-code-health.mjs --update`. Size/complexity entries are unchanged.
- Left on purpose (money, invoice, inventory or delivery files, for a money-reviewed PR):
  `invoiceAppliedCarryover.ts`, `BatchAdjustModal.tsx`, `OrderSearchPicker.tsx`,
  `customerInvoiceSummary.ts`, `deliveryEvidence.ts`, `fieldAppNewInvoiceAddress.ts`,
  `invoicePdf.ts`, `invoiceSeasonWindow.ts`, `invoiceSummaryPdf.ts`, `offlineQueue.ts`,
  `offlineReceipts.ts`, `paperTicket.ts`, `productPricing.ts`, `reconciliation.ts`,
  `supplierPricingWorkbook.ts`.
