## 2026-10-09 - New field-application invoices: no false "Unsaved Changes" box, no duplicate after Stay

App-only; no database change. Delivered as PR #893, which replaced PR #892 with the same code
(CodeRabbit kept a stale "changes requested" on #892). The invoice-list half of the original
change (last season's open invoices back on the lists) shipped separately in PR #895; see
`2026-10-12-invoice-lists-season.md`.

### Saving a new field-application invoice

**What staff will notice:** after the first Save of a new field-application invoice, the page now
goes straight to the saved invoice. Before, an "Unsaved Changes" box appeared even though the save
had worked, and choosing **Stay** then **Save** created a **second, duplicate** invoice.

- A fully successful save moves to the saved invoice with no prompt.
- If part of the save fails (for example the billing details), the form keeps your typed values
  and the prompt still appears, as before. Choosing Stay and saving again now **updates the
  invoice that was already created** instead of creating another one.
- Once the create has answered, the page writes the created invoice's id into its address
  (`/invoices/field-app/new?created=<id>`, same page, typed values kept). A **refresh** (or Back)
  of that address opens the **already-created invoice** with a note to re-enter anything that did
  not save, instead of a blank form whose Save would create a second invoice (CodeRabbit on
  PR #893). It opens whatever its status: a posted or returned-to-scheduling invoice is proof the
  create happened (Codex Sol 6.1 on PR #893). The page never saves onto that invoice from a form
  it did not load (a save replaces the invoice's lines): if the user chose Stay while it opened,
  Save waits and a box at the top links to it (Codex Sol on PR #893).
- If the address names an invoice this page cannot open (deleted since, someone else's, another
  kind, or not found), the page does **not** quietly become a new invoice: a box explains, and
  Save waits until the user presses **Start a new invoice instead** (typed values kept). If the
  check cannot run, Save refuses until a reload; Save also waits while the check runs.
- Pressing **New** starts a genuinely new, blank page; Back/Forward between two such pages opens
  the right invoice; a Save still running when the user presses New finishes its writes but no
  longer pulls them back to the old invoice.
- Two Save clicks before the page redraws send one save, not two.
- If the billing details step fails and the user changes a billing value before saving again,
  the change is now written instead of the server answering with its first result (Codex Sol
  on PR #893). The retry keeps its repeat-protection key, then sends the current values under a
  new key. The billing RPC saves the key in the same transaction as the update and the key is
  unique (checked live, 2026-10-13), so only one write per key can commit and an older write
  still running cannot land after the newer one (CodeRabbit on PR #893). An unchanged retry
  just keeps the key.
- A Save that got no answer and is retried with **changed** values no longer keeps the old
  values on the invoice: the retry keeps the unanswered save's key (the database runs saves
  with one key one at a time, so a create is never made twice and a still-running older update
  cannot land after it), then writes the current values onto the invoice under a new key (Luna
  and CodeRabbit on PR #893). The follow-up is only for a lost reply: when the server answered
  with an error (for example a closed accounting period), nothing was saved, so the retry is a
  plain save with no extra write or extra activity entry (Codex review on PR #893). Before, the database could answer
  the retry with the first attempt's result while the later steps saved the new billing and
  applied info, leaving a mix.
- The Discount Earned amount is read in exact cents. Anything that is not a plain dollar amount
  with at most two decimal places (`1.005`, `1e2`, `abc`) is refused with a message before
  anything is saved. It was rounded with binary floating point, so `$1.005` became `$1.00`
  (Luna on PR #893), and a first fix read `1e2` as $0 instead of refusing it (Codex P2 on
  PR #893). Blank, zero or negative still means no discount, as before. **Print** and **Email**
  refuse the same way, so a refused amount is never put on a PDF for the customer as $0 (Codex
  review on PR #893).
- If the page cannot tell which customer each saved invoice belongs to, it no longer writes the
  billing details with zero discounts while reporting success: it says the billing details did
  not save and keeps the form unsaved (Codex Sol 6.1 on PR #893; an invoice coming back with a
  blank customer counts too, Luna on PR #893).
- Deleting a field-application invoice, or transferring it back to scheduling, also leaves the
  page without a false "Unsaved Changes" prompt.

### Removed before landing: the "lost reply" recovery

Earlier heads of #893 also tried to stop a duplicate when the database created the invoice but
its reply was lost and the page was then refreshed: a draft tag in the address keyed the create,
and a reopened draft searched the user's recent invoices. Codex Sol blocked that four times in a
row, each time on a new edge case of the same guess (time windows, a capped search, a clock
running fast). A design review by Codex Sol 6.1 (2026-10-12) confirmed a screen cannot settle it
and recommended a permanent database record of each create request. That is planned as its own
change after admin-only invoicing (it has to build on that migration's version of
`save_field_app_invoice`), so this PR ships without the draft tag and the search.

### Not in this change

The regular invoice editor (chemical sales, misc charges, job/blend field invoices) can still
Post with unsaved edits on screen: it posts the saved amounts, exactly as before. That fix moved
to the admin-only invoicing change, together with a server-side check that the invoice was not
changed between review and posting (Codex Sol HIGH on PR #892, 2026-10-09: a check in the browser
cannot bind what `post_invoice` posts). Tracked OPEN in `docs/manual/KNOWN_ISSUES.md`.

### Proof

- `src/pages/FieldApplicationInvoice.saveNavigation.test.tsx` runs the real router, the real
  route wrapper and the real leave-page guard (only the database, sign-in and toasts are
  mocked). Its tests cover: no false prompt; Stay then Save updating the created invoice; the
  created id in the address with typed values kept; a refresh opening the created invoice (draft,
  unposted, posted, cancelled, created days ago, any UUID version); four kinds of address that
  must wait for "Start a new invoice instead"; typing while the check runs; a failed or running
  check refusing Save; New and Back/Forward; a Save left behind by New; two quick Save clicks; the
  billing key; the billing customer lookup failing, coming back short or with a blank customer;
  a create or update retried with changed or unchanged values after no answer. The Discount
  Earned amount is tested in `src/pages/FieldApplicationInvoice.test.tsx` (exact cents, refused
  at three decimals) and `src/lib/__tests__/parseCents.test.ts`.
- The 2026-10-13 fixes (posted opens, unopenable address waits, two clicks send one save,
  billing lookup refuses, blank customer refuses, changed-value create and update retries,
  over-precise discount refused) were each broken on purpose and their tests failed, then
  restored.
- Earlier rounds (Luna 3 to 8, CodeRabbit, Codex Sol) each added tests that failed against the
  commit before their fix.

### Known gaps (not fixed in this change)

- **Lost reply, then refresh, then re-type: still a second invoice, exactly as on main.** If the
  database creates the invoice but the reply never reaches the browser and the page is refreshed,
  the address has no created id, the typed form is gone, and saving the re-typed form creates a
  second invoice. Planned fix: the permanent create-request record above (Codex Sol 6.1 design,
  2026-10-12).
- **A changed retry after a lost reply can write twice.** The page cannot tell whether the
  server's answer was a replay of an earlier attempt or a fresh save, so it always follows up
  with the current values; when the earlier attempt never arrived, the follow-up repeats a save
  that already applied them (one extra "updated" activity entry, same final values). The planned
  create-request record will say whether the payload was applied (Luna round 8, MED, accepted).
- **The server does not check that a reused key carries the same values** (save or billing);
  the screen handles a changed retry as above. A write from a different page or tab is not
  ordered against this one.
- **One Save is several separate writes** (invoice, applied info, billing details, override
  note); a failure part way is reported and the form stays unsaved, but the steps are not one
  transaction.
- **A partly-failed first save** keeps some checks (season date guard, split preview) behaving
  as if the invoice were new until the page moves to the saved invoice (the server still refuses
  a filed-season change).
- **New pressed during a Save can be dropped** if the Save finishes while the "Unsaved Changes"
  box is open; nothing is duplicated or lost; press New again (Luna round 7, MED, accepted).
- **Re-typing the same application on a fresh page** creates another invoice; a screen cannot
  tell a re-typed application from a new one.

### Not verified here

- Not clicked through in a signed-in browser against live data.
