## 2026-10-25 — the invoice editors say a failed load could not be loaded (To-Do 10.5, fourth money PR)

- **Invoice Detail:** a failed line read left an editable invoice with no lines ("No line items
  yet", $0 subtotal), and Save sent that empty list over the real lines. Moving from one invoice to
  another whose lines failed kept the first invoice's lines, line ids included, under the second
  invoice. A read with no list left the spinner up for good. Now any failed read the form depends
  on (header, lines, split group, shares, write-offs, the customer's payment terms) shows "This
  invoice could not be loaded" with Try again in place of the form, so Save, Post, Print and Email
  cannot be reached. A failed header read no longer says "Invoice not found" and leaves the page;
  a missing invoice still does. A failed cost read shows the same state instead of leaving.
- **Field Application Invoice:** a failed chemical-line read showed the full editable invoice with
  no chemicals, and Save wiped the real lines; a failed sibling read let a split invoice be edited
  and Save zeroed every member's Discount Earned; a failed field-location count sent a per-acre
  invoice to the quantity-line editor. Now a failed or listless read of the header, location count,
  source job, siblings, locations, lines, label rates, shares or as-applied records shows the same
  failed state with Try again, including a reload after Save, Post, Unpost or Void (which is no
  longer reported as a failed save).
- **Split Billing editor:** a failed setting read said "Per-line split billing is not enabled"; it
  now says it could not be loaded, with Try again. A reopened draft whose invoices, lines or line
  shares read answered with no list enabled Post over lines nobody saw; it now shows "This split
  billing draft could not be loaded" with Try again. Moving between saved drafts drops the previous
  draft's review card and posting state.
- Not changed here: the invoice list screens and Order Detail's linked-invoices read (next PR, after
  #1095 and #1099, which edit the same files); the restricted-use and credit-limit checks before Post,
  which pass quietly when their own read fails; the address and shares on a printed invoice.
- Proof: `src/pages/InvoiceEditors.loadFailed.test.tsx` (22 of its 23 checks fail on the code before
  this change); each screen was checked in the dev app against a local fake Supabase server.
