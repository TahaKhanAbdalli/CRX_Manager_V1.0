## 2026-10-26 — A purchase order can be downloaded as a PDF, or a copy emailed for ordering (To-Do 0.15)

**What changed.** On a purchase order, admins now see two buttons:

- **Download PDF** — a branded purchase order: vendor (with contact, address, phone and email when the
  vendor record has them), buyer, order and requested-delivery dates, each product with its EPA number,
  quantity, unit cost and line total, the order total, notes, and "Page N of M" on every page. A draft is
  marked "DRAFT - NOT YET SUBMITTED" and a cancelled PO "CANCELLED - DO NOT FILL". Line and order totals
  are whole cents from the same helpers as the purchase order page (`src/lib/purchaseOrderPdf.ts`). A line
  with no cost yet prints "TBD" and is left out of the total; an unconfirmed cost is starred; both get a
  red footnote, so the PDF never shows them as firm prices. Vendor details wrap rather than being cut,
  long notes continue onto new pages, and the PDF is built from a fresh read of the PO and its lines.
  The PO notes box now says its notes print on the PDF.
- **Email PO Copy** (submitted or partly received POs) — asks to confirm, then emails that PDF to
  mason@croprxsolutions.com. Nothing is sent to vendors: Mason places each order himself through the
  supplier's portal (Mason, 2026-10-26: "we will not actually send vendor emails to them, will make copy
  and use that to make ordes through the portals our suppliers have so they can be sent to
  mason@croprxsolutions.com"). It says plainly, and sends nothing, when a line has a $0 or unconfirmed
  cost, the PO has no lines, or the PO changed since the page loaded.

Both are admin-only because a PO shows purchase cost, which is admin-only (Mason, 2026-10-18).

**Server side.** `send-email` gains the `purchase_order` type, allowed for admins only (sales reps keep the
10 customer types). It needs no `customer_id`; instead it needs `resource_type='purchase_order'`, and the
recipient must be the company ordering address (`PO_COPY_RECIPIENT`, kept equal to the app's
`COMPANY_ORDERING_EMAIL` by a test). The PO must be submitted or partly received with every line cost
confirmed, and what the app says the attached PDF prints (vendor, requested date, notes, and each line's
product, quantity and unit cost) must be exactly the PO at that moment, so an out-of-date copy is refused.
These checks run before the write-ahead log and again just before the provider call
(`supabase/functions/_shared/purchaseOrderEmailGate.ts`). Migration
`20261027070000_email_type_purchase_order.sql` adds the `purchase_order` value to `email_type` so the send
is logged in `email_log`.

**Not live until:** Mason approves deploying the `send-email` edge function (until then an Email PO Copy
attempt gets "Unknown email_type: purchase_order").

**Also recorded (docs only, no data change in this PR).** To-Do 0.14: the old stock holds are cleared.
On 2026-10-26 at 10:19 AM Central Mason had planned draft quote Q-2026-1994 cancelled in the app, and the
existing `trg_release_holds_on_quote_status` trigger released its 9 crop-program holds (about 1,234 units);
checked live read-only: 0 of its holds and 0 holds system-wide are active. To-Do 6.9: Mason decided to
leave the 5 completed deliveries on deleted orders as they are, and to fix the 14 March orders later (15.2).

**Proof.**
- PDF generated from the real lines of PO-2026-0024 and opened page by page: 12 lines, total $143,134.69
  (equal to the sum of its line totals and to the PO page); a 48-line test PO with a long vendor name,
  address and email, one unpriced and one unconfirmed line and very long notes runs to 4 pages: nothing
  cut, no row split across pages, TBD and star footnotes shown, total $559,204.01 (the 4x total less
  the TBD line), and a footer on each page.
- In the running app (admin): both buttons show on PO-2026-0024; Download PDF produces the same PDF.
- Tests: `purchaseOrderPdf.test.ts`, `purchaseOrderEmail.test.ts`, `purchaseOrderEmailGate.test.ts`
  (server gate decisions, the stale-PDF refusal, and wiring order) and
  `PurchaseOrderDetail.poCopyEmail.test.tsx` (confirm-then-send payload to the ordering address, key kept
  on failure, unconfirmed-cost and changed-PO refusals, draft and sales-rep visibility).
