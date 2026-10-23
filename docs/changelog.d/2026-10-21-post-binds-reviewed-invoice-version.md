## 2026-10-21 - Goal 3: Post uses what was saved and reviewed

- Posting an invoice now posts exactly the version the screen showed. Before, a save from a second
  tab or by another person just before Post was posted unseen (KNOWN_ISSUES "OPEN 2026-10-09").
- Migration `20261022022000_post_binds_reviewed_invoice_version` (not applied yet): a new computed
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
  retries, rep scope, five two-connection races, a committed cost-only edit, and four mutations
  (removing the line lock, the post-check or the group-write trigger reopens the gap; a trigger
  that waits instead of refusing deadlocks).
- A direct update or delete of a split group's member or field location while that group is
  being posted or saved is refused at once with `INVOICE_GROUP_BUSY` ("try again") instead of
  risking a database deadlock; a batch post sent the same invoice twice is refused.
- New trigger `trg_refuse_posted_invoice_child_write` (Codex GitHub App P1 on PR #1018): a write to
  an invoice's lines, billing shares or field locations that waited behind a post would otherwise
  land right after it. Such writes are now refused with `INVOICE_POSTED_LOCKED` once the invoice
  (or, for a group-level field location, any member) is posted, paid or overdue. Allowed on a
  posted invoice: return-credit lines going into their credit memo, and line updates that change
  only cost, return-credit cost, tote number or updated_at. Payment allocations are not covered
  (payments and voids write them on posted invoices). Prover races R4 (now refused after waiting)
  and R6-R7, mutation 5; a draft cannot join a split group that was posted while it waited.
- The same trigger now covers per-line split allocations (`invoice_line_shares`, Codex GitHub App
  P1 on PR #1018): the older posted-status trigger read the still-draft status before the insert
  waited on its line, so an allocation started during a post could land on the posted invoice. An
  insert now takes a key-share lock on its line first (waiting for the post), and a share moved
  onto a line of the posting invoice is refused at once. Prover race R8, mutation 6.
- Codex Sol advisory plan review (Mason's request, 2026-10-21) led to: a trigger so a direct write
  adding a group member or a group-level field location waits for an in-flight group post; the
  version map normalized and checked for duplicate ids before the retry check; the rep's
  own-name check before the version check; SHA-256 instead of md5; batch items must carry a
  version. The cost-column lock (Goal 1 step 3) must rework this field; see KNOWN_ISSUES.
- A sales rep who posts an invoice under another salesperson's name is told "You can only change
  or post invoices under your own name" instead of "reload" (Codex GitHub App P2 on PR #1018): the
  version field is withheld from them, so the screens send the placeholder `withheld` for a row
  loaded with no version and the server, which checks the own-name rule first, gives the reason.
  Anyone allowed to post the invoice gets "changed, reload". Prover P9 and G5.
- The version and the post lock also cover a payment allocation linked only to one of the
  invoice's lines (`invoice_line_allocations.invoice_item_id`; `ila_target_check` allows it and
  admins and reps can insert one directly), not just those linked to the invoice or a split
  invoice (Codex Sol on PR #1018). Prover P5c.
- A field location that names both an invoice and a split group (`fal_requires_parent` allows it;
  no RPC writes one, but admins and reps can directly) now counts for the group in the version and
  the post lock, and is refused once the group is posted even if its invoice is still a draft;
  before, only its invoice was checked (Codex GitHub App P1 on PR #1018). Prover G7d.
- Deploy order: until the new app is live, the old screens get "function not found" when posting;
  nothing posts unseen.
