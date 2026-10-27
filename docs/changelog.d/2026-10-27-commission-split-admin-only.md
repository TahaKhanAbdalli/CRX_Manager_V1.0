## 2026-10-27 — Only an admin sets or changes a customer's default commission split

- Mason, 2026-10-14 ("admin only on commision splits"), 2026-10-26 ("only admins change commission
  splits") and 2026-10-27 (new customers too). New migration
  `20261027080200_commission_split_admin_only.sql` (row 998, NOT APPLIED, placeholder stamp/row)
  changes `guard_customer_rep_edit_20261013()`: a sales rep who changes a customer's default split,
  or creates a customer with one, is refused with `COMMISSION_SPLIT_ADMIN_ONLY`. Re-saving an
  unchanged split and creating a customer without a split still pass.
- Same change: Customer Detail shows the split editor only to admins, new customers included; a
  rep's create sends no split and the page says an admin sets it; the error sanitizer maps the new
  token.
- Not in this change: job/quote/order splits (Goal 2 follow-up). The frozen container prover
  `prove-reps-work-any-customer-real-schema.mjs` still proves 20261013220000's rule, since it
  replays that migration last.
- Permission change: applies only after Mason's in-chat `I approve`.
- Proof (local replay of main `fe258c2f`, synthetic data): permission matrix "change a customer's
  commission split directly" is deny for both reps and allow for admin; "create a customer with a
  split" is deny for both reps and allow for admin; "create a customer with no split" and "re-save
  with the split unchanged" stay allowed for admin and both reps; no other cell changed; new
  CustomerDetail test (a rep's New Customer has no split editor and sends no split); error
  sanitizer tests updated.
- Not verified: live body md5 (local replay only).
