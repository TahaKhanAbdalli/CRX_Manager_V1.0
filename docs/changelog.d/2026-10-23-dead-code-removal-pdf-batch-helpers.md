## 2026-10-23 — Remove unused code before the developer handoff (part 2, PDF batch helpers)

Deletes four PDF helpers nothing in the app calls. Every PDF the app prints is unchanged.

- `src/lib/quotePdf.ts`: `getQuotePdfBlob` and `generateBatchQuotePdf`. Quotes print one at a time through `downloadQuotePdf` and `generateQuotePdf`.
- `src/lib/statementPdf.ts`: `generateBatchStatementsPdf`, which only ever built the first statement. AR Aging and Month-End Close print batches through `downloadBatchStatements`, which stays.
- `src/lib/receivingPdf.ts`: `generateBatchReceivingPdf`. Purchase orders and Quick Receive print single receipts through `downloadReceivingPdf`.
- The tests and one test mock that exercised only these helpers.

Confirmed unused by searching the whole repository (pages, tests, scripts, hooks, Edge Functions and docs). Part 1 is `2026-10-23-dead-code-removal-loadsheet-notifications.md`.
