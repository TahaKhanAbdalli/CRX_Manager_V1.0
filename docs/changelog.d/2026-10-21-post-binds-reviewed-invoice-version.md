## 2026-10-21 - Goal 3: Post uses what was saved and reviewed

- Posting an invoice now posts exactly the version the screen showed. Before, a save from a second
  tab or by another person just before Post was posted unseen (KNOWN_ISSUES "OPEN 2026-10-09").
- Migration `20261021200000_post_binds_reviewed_invoice_version` (not applied yet): a new computed
  field `invoice_post_version` (a fingerprint of the saved invoice, its lines, shares, allocations,
  field locations and the customer's payment terms, with every cost column left out) that screens
  read with the invoice row. `post_invoice`, `post_invoice_group` and `batch_post_invoices` now
  take that version (one per group member for a group) and refuse, inside the posting transaction,
  with `INVOICE_CHANGED_SINCE_LOADED` ("changed after this screen loaded it, reload") when the
  invoice, a group member, or the group's membership changed. They lock the invoice's lines too,
  and roll the post back if a line changed while it posted. Retries with the same key replay
  without posting twice; the key is bound to the versions. The old signatures are dropped.
- Invoice editor (`InvoiceDetail.tsx`): Post is greyed out with a note while there are unsaved
  edits; the credit-limit and restricted-use (RUP) warnings use the saved invoice; leaving with
  unsaved edits asks first; a "changed elsewhere" refusal reloads the invoice.
- Every other posting screen sends the version it loaded and refuses a changed row one at a time:
  the Invoices list, Office Cockpit, the Order page's Post All Drafts, the field-invoices Post All,
  the per-acre field invoice editor and the split-billing editor.
- Proof: `scripts/smoke/prove-post-binds-reviewed-invoice-version-real-schema.mjs` builds the
  production schema plus every migration in a throwaway database and shows the bug before the
  migration, then after it: a second tab and a second user saving before Post, groups, batch,
  retries, rep scope, three two-connection races, and two mutations (removing the line lock or the
  post-check reopens the gap).
- Codex Sol advisory plan review (Mason's request, 2026-10-21) led to: a trigger so a direct write
  adding a group member or a group-level field location waits for an in-flight group post; the
  version map normalized and checked for duplicate ids before the retry check; the rep's
  own-name check before the version check; SHA-256 instead of md5; batch items must carry a
  version. The cost-column lock (Goal 1 step 3) must rework this field; see KNOWN_ISSUES.
- Deploy order: until the new app is live, the old screens get "function not found" when posting;
  nothing posts unseen.
