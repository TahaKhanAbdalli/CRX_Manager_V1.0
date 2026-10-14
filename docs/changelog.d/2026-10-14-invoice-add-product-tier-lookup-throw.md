## 2026-10-14 — Invoice page: a price-tier lookup that throws while adding a product now says so

**Why.** Follow-up from the Sol review of PR #908 (merged as d12fc0f2a). When the invoice's customer
is not in the picker list, Add Product reads that customer's price tier by id. If that read ever
*threw* rather than returning `{ error }`, the product was correctly not added and Add Product / Save
unlocked, but no message was shown and nothing reached Sentry. This is a defensive backstop, not a
fix for something users were hitting: the installed Supabase client (`@supabase/postgrest-js`
2.117.2, `throwOnError` off, and `src/lib/db.ts`'s custom fetch runs inside its catch) already turns
a network failure into a resolved `{ error }`, which the existing branch toasts and reports. Only an
unexpected client or runtime error could reach the new `catch`.

**What changed** (`src/pages/InvoiceDetail.tsx`). The by-id tier lookup in `addProduct` gained a
`catch`. It runs the same "is this lookup still current?" checks as an answered lookup: a lookup
cancelled by an invoice switch or a closed picker stays silent; if the customer changed meanwhile, it
shows the existing "customer changed" toast. Otherwise it reports the error to Sentry
(`invoice_add_product_customer_tier`, normalized to an `Error` like the page's other catch sites) and
shows the existing toast "Could not load this customer's price tier. The product was not added; try
again." Every branch returns, so a thrown lookup can never fall through to pricing the product at
tier 1.

**Proof.**
- Three new tests in `src/pages/InvoiceDetail.test.tsx`: a throwing lookup shows the toast, reports
  to Sentry and saves nothing; a lookup that throws after the customer was switched shows the
  "customer changed" toast instead; a stale lookup that throws (invoice switched) stays silent and
  cannot unlock the newer invoice's lookup. The file now mocks `../lib/sentry`.
- Mutation runs: the old page (no catch) fails 2 of them; a catch that does not `return` (falls
  through to tier-1 pricing) fails the first; a catch without the "still current" checks fails the
  other two. The fixed page passes all 48 tests in the file; typecheck, lint and build are clean.
- Codex Luna round 1: clean. Compliance review: 0 BLOCKER / 0 HIGH; its MED (the original wording
  claimed network failures throw — they do not, see Why) and all four LOWs were applied.
- Not verified on screen: the path needs a lookup that throws, which the real client does not do for
  network failures, so the rendered-page tests are the proof.
