## 2026-10-26 — The price sheet is safe to use (To-Do 0.1, PR B)

Migration `20261026230000_price_sheet_warnings_and_approval` (not yet applied) and the screens that
use it. Every pricing change (the price sheet upload, the Products-list edit, the product page) still
goes preview, then apply; now, in the database:

- **Warnings.** The preview flags each product whose cost or a price moves more than 10%, that has a
  price below cost, a margin under its floor (To-Do 0.2), or an open sent quote that would re-price on
  its next save (until the sent-quote price lock, To-Do 1.2, is live).
- **Sign-off.** The preview window lists every warned product and needs a reason for each before
  "Apply approved changes" unlocks. The database records the approval (who, when, each reason, and for
  a price sheet the file's name and SHA-256) and refuses to apply without it, or if the warnings
  changed since.
- **Source and reason.** Every price, cost or per-acre rate change needs both. The price sheet has a
  new `price_source` column (older downloads are refused; download a fresh sheet), and the
  Products-list and product-page edits ask for them before the preview instead of filling a generic
  reason. Per-acre rate changes now write price history too.
- **Full price sheet.** A new "Full price sheet" button on the Products page exports every active
  product, whatever the filters or selection.

The live pricing smoke chain `smoke-supplier-cost-basis-phase2-live.sql` follows the new rules (source
and reason on each row, approval-function security checks, an unapproved apply refused, each route
approved before apply) and covers `approve_pricing_change_set`. It also had a check of the price-sheet
export placed above the export itself, so it could never pass; that check now follows the export.

Proof: `node scripts/smoke/prove-price-sheet-warnings-real-schema.mjs` passes (144 migrations replayed,
41 steps before and after, the mutation test, and the live pricing smoke chain run on the candidate). The price sheet stays off for live price changes until
the sent-quote lock is live and floors are set.
