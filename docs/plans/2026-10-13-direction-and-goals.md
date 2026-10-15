# CRX Manager: Direction and Goals (October 2026)

**Owner:** Mason Wells. **Drafted:** 2026-10-13, from the scalability review (Claude, plus two independent Codex Sol reviews). Mason's decisions were recorded the same day.
**Revised:** 2026-10-14, after an independent Codex `gpt-6.1-sol` (high reasoning) review of this plan. Mason asked for that model by name, and the review was advice on the plan, not a ship gate. Ship gates still use the pinned models in `docs/reference/codex-model-tuning.md`, and this docs-only change uses the documentation-only exemption. Claude checked that review's key claims against the code and the live system before applying them.
**Status:** ACTIVE. Mason sets the goals; open decisions are in section 6.
**Replaces:** the priority order in `docs/roadmap/2026-07-15-roadmap-and-execution-plan.md`. The north star there still stands.

> For agents: this doc says *what* matters and *in what order*. It does not authorize building anything. Before you build an item, check its current state in `docs/manual/CURRENT_STATE.md`, `docs/manual/KNOWN_ISSUES.md` and the live database. Plan docs go stale.

---

## 1. The goal

**Run Crop RX Solutions as a $10 million-a-year business on CRX Manager.**

That means every quote, order, delivery, invoice and payment for the season lives in CRX. The numbers are complete and correct, and the totals reach the accounting books without retyping. Customer and compliance data is only visible to the people who should see it. And a bad day (a bug, a lost database, an outage) costs hours, not weeks.

## 2. The plan: four phases

| Phase | What happens | Done when |
|---|---|---|
| **A. Build** | Finish Goals 1–7 below, including the QuickBooks and payment integrations, while tracking Goal 8. Alongside, Mason runs the business readiness tasks L1–L3 himself (no code, not an agent gate). | Goals 1–7 each pass their "done" test. Goal 8 is an ongoing target, not a gate. |
| **B. Clean up** | Goal 9: docs, files, branches, open issues and the AI tooling all tidied and explained. | A newcomer can find, run and understand everything. |
| **C. Hand off** | Goal 10: an outside **senior software developer** gets the handoff pack, sets the system up, and reviews it independently. | Their must-fix list is fixed and rechecked, **and** they sign off in writing. |
| **D. Roll out** | Chem Man issues its last new bill on **2026-12-31**. From **2027-01-01** all billing runs in CRX; the first 30 days are the pilot. | The 30-day pilot reconciles every day and is signed off (Phase D below). |

**Goal numbers are priorities, not a strict one-after-another order.** Three things start now, in parallel with Goal 1:
- **Goal 6's test system and backups.** The billing, volume, offline and integration proofs in Goals 3–5 and 7 need a safe test system to run on.
- **Goal 7's outside lead times:** the accountant's answer (6a), the QuickBooks Desktop connection test, and payment processor sign-up (6c). Each can take weeks before any code is written.
- **Lining up the senior developer (6d).**

Sessions can run side by side only when they don't change the same database functions or migrations. Working on different screens is not enough.

**Dates (Mason, 2026-10-14):** Chem Man's last new bill is **2026-12-31**. CRX-only billing starts **2027-01-01**, and the first 30 days are the pilot.

**Timeline risk: this is very tight.** From 2026-10-14 to 2027-01-01 is about 11 weeks. The Phase A estimates add up to roughly 14–25 weeks, plus about a week for the Goal 2 follow-up (its main change shipped; Mason's Supabase billing change takes minutes and is not counted), and cleanup plus handoff add another 4–7. Hitting January 1 needs early decisions, proven integrations, heavy overlap, and the work ordered by what must be ready that day. It is not yet a reliable forecast.

**Checkpoints:**
- **By 2026-10-31:** test system and backup work underway; accountant asked; payment processor and senior developer chosen.
- **By 2026-11-15:** a QuickBooks Desktop connection proven with a real invoice, a payment applied to it, and a credit, in a copy of our actual company file.
- **By 2026-11-30:** Goals 1, 3, 5 and 6 done, and the Goal 2 follow-up (own-name on every invoice path, reps read every invoice, admin-only commission splits) shipped.
- **By 2026-12-15:** Goals 4 and 7 done, and a test month reconciled in QuickBooks on the test system.
- **December:** the senior developer's review and repairs; the cleanup the developer needs (setup guide, AI tooling guide); staff training.
- **2026-12-31:** last Chem Man bill; Mason's opening balances in place (L3).
- **2027-01-01:** CRX-only billing; the 30-day pilot begins.

If a checkpoint slips, Mason gets a revised forecast straight away. Cut optional extras, cosmetic cleanup and archive tidying first; the rest of Goal 9 can follow the pilot. Security, billing correctness, backups and money correctness stay in scope. If the QuickBooks sync or online payments can't be proven in time, Mason decides: either move January 1, or start on January 1 with entries keyed into QuickBooks by hand and payments recorded as today, until the integration is proven.

## 3. Where we are today

**Already strong. Keep it.**
- Many money and inventory rules are enforced inside the database itself, not just on screen, with protection against double-clicks and two people changing the same record at once. That's a strong foundation, not a guarantee. One known gap: if a driver's connection drops and they change the quantities or signer before retrying, the retry can save the first version's numbers while the screen shows the new ones (`src/pages/DeliveryDetail.tsx`, the comment above the completion call). Goal 3 closes this.
- There are four staff roles (admin, sales rep, driver and applicator), plus a commission-recipient identity type. Every table has access rules; Goal 1 proves what each identity can actually read and change.
- Stored data is small (under 100 MB on 2026-10-13). Size alone doesn't prove speed under a busy day, so Goal 4 adds a workload test.
- Field features exist: offline mode, lot tracking, EPA/RUP (restricted-use pesticide) features, PDFs and email. Having compliance features is not the same as being compliant; see L1.
- **Shipped 2026-10-14:** reps work with any customer (Goal 2's main change, PR #907, migration applied live), and React 19.3.0, the framework the screens are built on (PR #906, live). Neither is remaining work.

**The real bottleneck is usage, not features.** On 2026-10-13 the app held about 13 invoices, 65 orders and 4 quotes in total, and spring 2026 was billed in Chem Man. The July roadmap made the same observation (8 invoices then). In three months the app's tooling grew a lot, but the business running through it barely did.

**Gaps:**
1. **Security.** Any logged-in user can pull the restricted-use sales register (confirmed live). Photos are viewable by link. Field staff can read cost data.
2. **Billing correctness.** Posting with unsaved edits uses the old amounts. A voided delivery leaves its posted invoice collectible. Some invoice types have no quantity caps. Blend-ticket pricing can pick the wrong price, and a product added on the invoice screen ignored the customer's price tier until PR #908 (merged 2026-10-14). Accepting a sent quote re-prices it to today's tier price before it becomes an order, so a price change after sending changes what the customer is billed (confirmed live 2026-10-14; see Goal 3, "Sent quotes keep their prices").
3. **Incomplete data at volume.** Reports, some integrity checks, pickers and list pages stop at 200–2,000 rows.
4. **Weak safety net.** The repo has weekly table snapshots, but they live inside the same database. The architecture doc describes an off-site copy, but no automated job for it exists in the repo, so it needs checking. The free hosting plan has no point-in-time recovery (rewinding the database to a chosen moment). Database backups don't include uploaded files. A test restore has never been done. There's no staging copy (a separate test system), and the browser tests are switched off until one exists.
5. **Offline proof of delivery.** A delivery completed without signal saves no signature image, and starting a field stop needs signal.
6. **Not yet the system of record.** There's no link to QuickBooks and no online payments.
7. **Not yet launch-ready outside the code.** No compliance sign-off, no physical stock count reconciled to CRX, and no plan for opening balances. Mason handles these himself (L1–L3).
8. **Process cost.** The AI tooling is nearly as large as the app.

## 4. Decisions made (do not reopen)

| Date | Decision |
|---|---|
| 2026-10-13 | **Sales reps may create, post and email invoices for ANY customer**, and see and edit all customers and their related records. This reverses the 2026-10-09 admin-only plan; PR #902 was closed unmerged and never applied. Shipped 2026-10-14 (PR #907). |
| 2026-10-13 | **Reps invoice under their own name only.** A rep can't name another salesperson on an invoice; admins can reassign who gets credit. |
| 2026-10-13 | **Reps read every invoice;** other reps' invoices are read-only to them. Ships as the next change after PR #907. |
| 2026-10-13 | **Upgrade Supabase to the Pro plan with point-in-time recovery** before next season. It's a billing change, so Mason does it. |
| 2026-10-13 | **Photos become private:** delivery, receiving and team-note photos need a sign-in to view. |
| 2026-10-14 | **Chem Man's last new bill is 2026-12-31; all billing runs in CRX from 2027-01-01**, and the first 30 days are the pilot. This replaces "by spring 2027" (2026-10-13). |
| 2026-10-14 | **Product lines are billed only for delivered goods.** Money paid in advance is recorded as prepay. |
| 2026-10-14 | **Invoices made from scratch carry no product lines,** only service or misc charges. Product sales go through an order and a delivery; a counter sale uses a quick delivery. |
| 2026-10-14 | **Only admins change commission splits**: on customers, jobs, quotes and orders. |
| 2026-10-14 | **An outage may last overnight:** CRX is back up by the next business morning. |
| 2026-10-14 | **Mason Wells owns pesticide compliance and inventory readiness,** and runs L1–L3 himself. They need no code and are not agent-enforced gates. |
| 2026-10-13 | **Everything is built before handoff, integrations included.** Accounting sync and online card/ACH payments are part of Phase A. |
| 2026-10-13 | **The books stay in QuickBooks Desktop** (most company data is there today). CRX syncs to it. |
| 2026-10-13 | **All AI tooling is kept at handoff** and documented for the developer (Goal 9). |
| 2026-10-07 | **Returns on Chem Man-billed deliveries stay allowed**, with the credit handled in Chem Man or the books. |
| 2026-10-13 | The scalability review's verdict: **strong foundation, no rewrite; not yet ready for $10M.** |

## 5. Goals, in order

Each goal has a plain test for "done". That test is the **minimum**: each goal's own pull request turns it into exact test cases, covering every role, path and failure case it touches, and those are reviewed with the code. Sizes are rough agent-build estimates, not promises. "Live checks" and "staging" tests run on a real database: the live system for read-only and permission checks, a copy for anything that creates money or stock records.

### Phase A: Build

#### Goal 1: Close the security holes (about 1–2 weeks)
- Only admins can pull the restricted-use register.
- Photos require an active staff sign-in to view.
- Drivers and applicators can't read product cost or margin; applicators only see fields for their assigned jobs.

**Done when:** separate checks, one per rule and identity, all pass. Read-only access and refusal checks run on live. Anything that writes runs on the isolated test system (Goal 6), unless Mason approves a specific live test in that conversation. That includes new uploads, previews, printed documents, deactivating an account, and ending an assignment.
- an admin can pull the register, and a sales rep, driver and applicator are each refused;
- for each of the three photo buckets (`delivery-photos`, `receiving-photos`, `team-note-attachments`): old public links stop working; viewing a photo needs an active, authorized staff sign-in every time, so a copied link alone grants nothing; a signed-out visitor and a deactivated account are each refused; existing photos, new uploads, previews and printed documents still work for staff. An expiring "signed" link does **not** meet this on its own, because anyone holding it can open it until it expires;
- customer delivery receipts keep working without exposing private staff-photo links. Today's receipt email embeds the photo links directly (`src/lib/deliveryCompletionEmail.ts`), so this has to be redesigned along with the photo change;
- a driver and an applicator are each refused cost and margin data;
- an applicator sees fields for their assigned jobs and is refused other fields. Ending the assignment removes the access without breaking legitimate field work.

The checks test the server, not just hidden screens: direct table reads, views, exports, files and callable database functions, each tried as every role, a signed-out visitor and a deactivated account. That includes every cost-bearing source and every field reached through a job, a location dispatch or a crew.

#### Goal 2: Reps invoice any customer, under their own name. MAIN CHANGE SHIPPED 2026-10-14
PR #907 merged and its migration (`20261013220000_reps_work_any_customer`) was applied live on 2026-10-14. Reps now find, read and edit all customers and related records, and save and post manual invoices and invoice groups for any customer under their own name. Only admins reassign customers. The customer-documents service was redeployed on 2026-10-14 (version 2).

**Still to do (the "Invoice work continuation" session's follow-up change; about 1 week; due 2026-11-30, before the December developer review):**
- **Own-name everywhere.** The own-name rule also covers invoices generated from orders (single and split), and every path a rep can use to edit, unpost, consolidate or transfer an invoice. Taking payments and applying prepay or credits keep working under their current rules.
- **Reps read every invoice,** with other reps' invoices read-only. Until then, a customer balance a rep sees may count only that rep's invoices. It must be labelled as such and never treated as the customer's full balance or credit exposure.
- **Only admins change commission splits** (Mason, 2026-10-14), on customers, jobs, quotes and orders. This tightens what shipped: today a customer's assigned rep may edit that customer's default split, and any active rep can edit a job's split.

**Done when:** a rep account does all of the following for two customers, one with no assigned rep and one assigned to a different rep. Every step that saves, posts, emails, unposts, changes a split or touches a document runs on the isolated test system (Goal 6), including the attempts that are expected to be refused: if a guard were missing, a "refused" attempt on live would really change customer balances, commissions or documents. The live system is used only for read-only checks, unless Mason approves a specific live test in that conversation.
- finds the customer when invoicing;
- saves, posts and emails both a single invoice and an invoice group (split invoice) to them;
- is refused when naming someone else as salesperson, through the screens **and** direct server calls, on repeat requests, and on an invoice group with mixed owners. A blank or missing salesperson is filled in with the rep's own name, not refused (shipped behavior);
- is refused when changing any commission split, while an admin can;
- can read another rep's invoice but cannot change it, unpost it, or alter its split set;
- can upload, download and remove a document for a customer assigned to another rep, while a deactivated account is refused;
- customer totals reconcile across invoices made by an admin and by two different reps.

Admin reassignment still works throughout.

#### Goal 3: Billing you can trust (about 2–4 weeks)
- **Post uses what was saved and reviewed.** Post refuses while the screen has unsaved changes. The database enforces this, not just the screen: `post_invoice` and `post_invoice_group` check the invoice version the screen loaded and refuse if it changed. That way a save from a second tab or another user can't be posted unseen (see `KNOWN_ISSUES.md`). Group posting checks every member and the group's membership.
- **Retries are safe.** A request that may or may not have gone through can be retried. If its quantities, customer, signer or amount changed in between, the retry must not silently reuse the earlier result. This includes the driver-retry gap in section 3.
- **Voids and cancellations.** Voiding or cancelling a delivery leaves nothing collectible for the goods on **that delivery**. A credit for exactly the voided delivery's value is issued automatically, or the void is refused until an admin issues it. Charges for the order's other deliveries stay collectible. A warning message alone (today's behavior) does not count. If the invoice was already paid, the customer gets the right credit or refund, not a made-up unpaid balance.
- **Quantity caps.** Product lines are billed only for goods actually delivered, and money paid in advance is recorded as prepay (Mason, 2026-10-14). The cap holds across all of an order's invoices and split children together, including two attempts at once, added lines, returns, credits and restored invoices. The existing ban on mixing whole-order and per-delivery billing stays.
- **Orderless invoices** (made from scratch, no order or delivery) carry **no product lines** (Mason, 2026-10-14, 6e). This holds on every way of creating, editing or importing one, and on direct server calls. Service and miscellaneous charges stay available. A counter sale goes through a quick delivery, which ties the invoice to real goods.
- **Pricing.** Blend-ticket billing uses the exact quoted line, even when a quote has the same product twice at different prices. Today it takes the first matching line in an arbitrary order. A product added on the invoice screen uses the customer's tier (PR #908, merged 2026-10-14; confirm it on the saved invoice and PDF), and changing the customer refreshes the price without silently replacing an agreed quoted price.
- **Split billing.** Partly delivered orders shared among customers are handled by a proven workflow. Today this is a known limitation (`KNOWN_ISSUES.md`), partly because separate rounding of each share can lose cents. Customer shares add up exactly to the source charge. The Bill Split customer-list fix (PR #909) merged on 2026-10-14; the wider partial-delivery limitation above is still open.
- **Old Chem Man sales.** Returns against Chem Man-billed deliveries **stay allowed**, before and after the cut-over, with the credit handled in Chem Man or the books (Mason, 2026-10-07). Keep the original billing reference, record where the credit was handled, and never credit the same old sale both in CRX and in the books. A written procedure for old-sale returns stays in place after Chem Man stops issuing bills.
- **Sent quotes keep their prices** (Mason, 2026-10-14). Accepting and converting a quote bill the prices the customer was sent, not today's tier price, and the database enforces this. A price-list change reaches a sent quote only when someone picks "update to today's prices" (per line or for the whole quote) in a revision. Any revision that changes a price must be re-sent before it can become an order or be partly drawn, and the order then uses the newly sent prices. The quote screen also offers a rewind to the version last sent, except on a booking that has ever been partly drawn (an existing safety rule). This is slice 2 of `docs/plans/2026-10-13-pricing-history-cost-tracking-and-quote-pricing-PLAN.md`, which holds the details: matching lines on revised quotes, rewinds, tier changes and partly drawn quotes.

**Done when:** each case is run against a real database copy and refuses or corrects as described. That includes these cases:
- **Posting:** unsaved price, quantity, customer and charge edits; a second tab and a second user saving just before Post; a changed or added split sibling; and every single, group and batch posting route. Credit and RUP checks use the same saved data that gets posted. Leaving a screen with unsaved edits warns first. An uncertain reply can be recovered without posting twice.
- **Voids and cancellations:** both voiding and cancelling, against draft, posted, overdue, partly paid and fully paid invoices, with whole-order and split billing, discounts, taxes, and earlier returns and credits. On an order with several deliveries, voiding one removes only that delivery's value and the rest stays collectible. Repeat or simultaneous requests never restock, credit or refund twice.
- **Caps and orderless invoices:** a second invoice that would exceed the order's allowance is refused, including when the first was split. An orderless invoice with a product line is refused, on both save and post, while one with only service or misc charges still saves and posts.
- **Pricing:** a blend with two lines for the same product at different prices bills each correctly, checked through the saved invoice, the PDF and the accounting entry.
- **Quote prices:** a tier price changes after a quote is sent; accepting and converting it still puts the sent prices on the order, invoice and PDF. A revision that changes a price is refused at Convert until it is re-sent, then bills the new prices. Revise-then-convert, rewind-then-convert and "update to today's prices" each pass the cases listed in the pricing plan's slice 2.
- **Split billing:** partly delivered and per-acre splits, several delivery dates, final remainders and returns, with every quantity and cent accounted for.
- **What the customer actually receives:** the office and bookkeeper review real printed and emailed invoices, split invoices, credits, statements and delivery receipts. They check recipient, address, product and unit, price, discounts, tax, due date, payment instructions and final balance, including long and corrected documents, season boundaries and aging cutoffs. A failed email stays visible and can be retried without billing twice.

#### Goal 4: Complete, correct numbers at any volume (about 2–4 weeks)
- Money reports and the remaining integrity checks are computed in the database.
- Pickers become search boxes.
- List pages get real paging and search.
- Every list, picker, report, export and integrity check that stops at a row limit is listed first, including server-side limits and the 200-row payment history.

**Done when:** with test data past the old limits (for example 5,000 invoices, more than 5,000 invoice lines, and a 200+ payment history):
- every money total matches a database sum to the exact cent;
- every record-based integrity check matches a direct database count;
- picker search finds records beyond the old limits;
- list paging and search reach every record, with no rows missed or repeated while records are being added and edited;
- a failed or partial read never shows a zero or a complete-looking total.

Matching a sum is not enough on its own, because a report can add up the wrong rows. The bookkeeper also approves what each financial report means: which statuses count, the date basis, returns, credits, prepay, write-offs, costs and taxes. Results are compared with independently prepared expected answers, including customers or products with the same name, renamed records, closed seasons and Chicago date boundaries. Profit reports use the cost-snapshot data, not today's product costs.

**Workload test:** estimate the busiest day's users, deliveries, invoice lines, uploads and accounting and payment events. Run twice that on staging while reports and syncs run. Agree response-time targets before the test, and record slow spots and errors.

#### Goal 5: Proof of delivery works offline (about 1–2 weeks)
- Signature, photos and receipt sync when the device reconnects.

**Done when:** on the supported phones and installed app, both delivery completion screens keep the signature, photos, signer, quantities and capture time through airplane mode, closing the app and restarting the phone. Reconnecting applies the stock and billing change once, uploads the evidence, and sends the customer receipt once. Also tested:
- a lost reply, an interrupted upload, large photos and an expired login;
- another user signing in on the same phone;
- a delivery reassigned or cancelled while offline;
- full phone storage and a failed email.

Failed work stays visible and recoverable. The app tells the driver which steps still need signal, including starting a stop.

#### Goal 6: A real safety net (about 2–3 weeks, plus Mason's billing click). START NOW
- Supabase Pro plus point-in-time recovery (decided). Both are needed; neither backs up uploaded files.
- Photos and uploads backed up too.
- A test restore every quarter, timed and logged. The first is overdue.
- Check whether the off-site backup the architecture doc describes actually runs; if not, build one.
- A staging system: a separate test copy of CRX with its own accounts, test payment credentials and captured test email. Its scheduled jobs and integrations can't reach the real systems. It is rebuilt from the documented schema baseline plus reviewed later migrations (`supabase/baselines/README.md`); the old migration history is not a safe way to build from zero. The browser tests come back on in CI against it. The developer will need this too.

**Done when:**
- a live check confirms the project is on Pro with point-in-time recovery on;
- a restore drill succeeds and is logged. It restores the database, permissions, user access and files from each protected upload bucket into an isolated copy, and the restored photos and uploads open and match their records;
- one rewind-to-a-time recovery is practiced on a throwaway copy;
- before syncing resumes after a restore, payments already processed, QuickBooks entries already written and emails already sent are reconciled, so nothing is charged, invoiced, credited or emailed twice;
- recovery meets Mason's target (2026-10-14): an outage may last overnight, with CRX back by the next business morning, and lost work is limited to what point-in-time recovery allows (minutes, not a day);
- a named person and a backup know how to run the recovery, and the paper fallback for dispatch, delivery and payments during an outage has been rehearsed;
- CI runs the money and inventory browser tests for each role against staging, and a failing test blocks the change. One passing run is not a safety net; it has to keep running.

#### Goal 7: CRX becomes the system of record (about 6–10 weeks). START THE OUTSIDE STEPS NOW
- **QuickBooks Desktop sync.** Invoices, payments and credits flow from CRX into QuickBooks Desktop, and each night's results reconcile.
  - Desktop has no simple cloud connection. First prove a connection works with our actual QuickBooks edition, year, Windows setup and company file, before committing to a build estimate (checkpoint 2026-11-15).
  - Prefer an established paid connector that proves it can apply payments to the right invoices, handle credits and recover from failures. If none does, build on Intuit's Web Connector (a small Windows program on the QuickBooks PC) or the Desktop SDK.
  - Import files (IIF) are a fallback only, not the default. Intuit says ordinary IIF imports don't link payments to the invoices they pay, which breaks "no retyping".
  - **Desktop operating plan:** which PC or hosted Desktop runs it, where the company file lives, supported versions, the schedule, QuickBooks' permission for the app, and the responsible bookkeeper. A named person gets an alert when a sync stops; nobody assumes each night worked.
- **Accounting map, approved by the accountant before coding.** It covers how each of these reaches the books:
  - invoices, credits and payment allocations;
  - prepay and deposits, refunds and write-offs;
  - finance charges, discounts, and tax and exemptions;
  - processor fees, inventory costs, and vendor bills and payments;
  - commissions.

  For each one, name which system creates it, which may correct it, and how it reaches the other. Nothing is entered in both. Include the chart-of-accounts mapping and the rules for closed periods.
- **Online card and ACH payments.** Use the processor's own hosted payment page; CRX never stores card or bank numbers. A payment link only lets the customer pay that invoice; it is not the grower portal. An invoice is marked paid only on a verified processor event, never because a browser showed a success page. Name which processor event counts as "settled", and how later bank deposits and fees reconcile.
- **Opening balances and cut-over:** Mason's task L3.

**Done when:**
- a full test month of invoices, payments **and credits** lands in QuickBooks Desktop. It matches CRX in transaction counts, invoice numbers, each customer's open balance, payment allocations, credits and the agreed accounts, not just the grand total;
- sync failures are tested: partial and multi-invoice payments, unapplied money, a repeated export, a lost acknowledgement, a batch that fails halfway, an edit made in QuickBooks, and a restore of either system. Recovery picks up from confirmed results without duplicates. Each CRX record keeps a permanent link to its QuickBooks record, unresolved entries are visible with an owner, and closed periods are never silently rewritten;
- a **card** payment and an **ACH** payment each settle end to end in the processor's test mode. Then one small real card payment and one small real ACH payment settle on live. These move real money, so they run only after Mason approves each one in that conversation. Every other payment case below runs in the processor's test mode;
- a pending payment and a failed or declined one each leave the invoice unpaid, with its balance unchanged, until the processor confirms settlement;
- a settled payment later reversed (an ACH return or a card chargeback) reopens the invoice balance exactly once, and the reversal reaches QuickBooks;
- also tested: duplicate, late, forged and out-of-order processor notifications; a lost reply; repeated clicks; paying an already-paid or voided invoice; partial, multi-invoice and over-payment (overpayment becomes prepay); partial and full refunds; and a chargeback later resolved. Each changes the customer balance and QuickBooks exactly once. Gross payments, fees and net bank deposits reconcile.

#### Business readiness tasks L1–L3 (Mason's; no code; not an agent gate)
These aren't app features, but the business needs them before January 1. **Mason Wells owns all three and runs them himself** (2026-10-14). Agents don't build anything for them and don't hold other work waiting on them. If an agent finds a code defect in one of these areas, it still reports it. The lists below are a checklist for Mason, not acceptance tests.

**L1. Compliance readiness.** Mason writes down the dealer, RUP sale, applicator, application-record, record-keeping and state-reporting rules for every state we serve, with an outside adviser where needed. Note that today the RUP license check only warns and never blocks a sale (`src/lib/rupCompliance.ts`). If a rule forbids the sale outright, Mason decides whether the app should block it, and that becomes a normal code request.

**Checklist:**
- the active catalog's EPA numbers and labels are verified;
- the required customer and staff licenses are on file;
- missing, expired and wrong-state licenses, label restrictions, application records, corrections, voids and returns all look right;
- a full reporting period produces correct state reports.

**L2. Inventory readiness.** Count the stock by product, package size and location. Bring CRX in line through approved, logged adjustments. Clear out old deliveries, reservations and supplier receipts that still hold stock (`KNOWN_ISSUES.md` records wrong opening stock and old orders still reserving goods).

**Checklist:**
- the counts match CRX, and every accepted difference has an owner and a resolution date;
- receiving, partial delivery, return, void, transfer and field-application use all hit the same stock records, including package conversions, damaged returns and lot tracing.

Warn-only shortages stay the policy until Mason decides otherwise (6b), but every shortage has someone assigned to deal with it.

**L3. Opening balances and cut-over.** Chem Man's last bill is 2026-12-31 and CRX's first is 2027-01-01.

**Checklist:**
- every opening customer balance, unpaid invoice, prepay or deposit, unapplied payment, outstanding credit, open order, unbilled delivery and stock balance matches Chem Man, QuickBooks and the physical count;
- original IDs and the billing system each record came from are kept, and nothing is entered twice;
- what history moves into CRX, what stays read-only in Chem Man, and how old-sale returns work after 2026-12-31 are all written down;
- the bookkeeper signs the opening balances, and the Chem Man history can still be opened after billing stops.

#### Goal 8: Spend on product, not process (ongoing; reviewed monthly through handoff, not a Phase A gate)
- Keep the freeze on new safety guards.
- Track product changes merged vs. tooling changes merged each month. **Target: at least 3 to 1.**
- **Monthly readout for Mason.** It shows the ratio next to real business results:
  - invoices and dollars billed in CRX;
  - unbilled deliveries and jobs;
  - unexplained reconciliation differences;
  - failed emails;
  - staff blockers;
  - the next launch dependency.

  The ratio is a steering signal, never a reason to split pull requests or delay a needed business fix.

### Phase B: Clean up

#### Goal 9: Everything tidy and explained (about 2–3 weeks)
- **Docs.**
  - Cut `docs/` (about 1,000 files) down to a current set. Archive history instead of deleting it.
  - `KNOWN_ISSUES.md` (about 5,800 lines) becomes a short list of what's actually open; the history moves to an archive.
  - Mark stale plans as superseded.
- **Files and repo.**
  - Remove stray temp folders and unused scripts.
  - Give every parked migration a checked outcome: delivered, closed as superseded, or deferred with an owner, a reason and a review date. Never apply one just to clear the list. Applied migration history and the supported rebuild baseline stay as they are.
  - Archive or remove only branches and worktrees that are finished, clean and not in use, after saving any unmerged or unpushed work, and keep a record of what was kept and why. The branch-cleanup audit (PR #901) is open.
- **Open issues.** Every remaining known issue is fixed, or written down as an accepted risk with a reason.
- **Historical money data.** Old financial records and audit gaps that affect opening balances or kept records are reconciled separately. Correct only from reliable evidence, through the approved process. Where something can't be rebuilt, keep the original evidence and record the limitation, the affected records, the business impact and the accountant's decision. Never delete history or mark it correct just to shorten the issue list.
- **AI tooling guide** (kept, per decision). One plain document covering:
  - what each hook, gate and script does;
  - how a human developer works alongside it;
  - which tools are optional and which gates are mandatory, and how a human completes the protected delivery process;
  - how to troubleshoot a gate and request a reviewed policy change when needed. The guide does not authorize bypassing or switching off required hooks, reviews, CI, migration or rollback protections.

**Done when** all of these hold:
- a newcomer can go from a clean checkout to a running app and passing tests by following the docs alone;
- every parked migration has a checked outcome;
- every open known issue is either fixed or marked as an accepted risk with a reason;
- no finished, unused branches or worktrees remain, and nothing unmerged was lost;
- every stale plan is marked superseded;
- the AI tooling guide exists.

### Phase C: Hand off

#### Goal 10: Senior developer handoff and review (about 2–4 weeks with the developer)
- **Handoff pack:**
  - setup guide (under one hour to a running local copy), and how to rebuild the database and staging from scratch;
  - architecture and data model;
  - business rules (quote to cash, inventory, commissions, compliance);
  - operations runbook: deploys, migrations, rollback and restore evidence, scheduled jobs and monitoring, and integration retry and error procedures;
  - the accounting and payment maps;
  - service costs and renewal dates;
  - a list of every credential that exists and where it lives, never the secret values;
  - where retained history lives;
  - decisions log;
  - open issues and known limitations, each with an owner;
  - AI tooling guide.
- **Access:** GitHub, Supabase, Vercel, Sentry, the email service, Google Vision, Mapbox, the payment processor, the QuickBooks company-file environment, the connector, and the backup systems, with the accountant or bookkeeper involved where needed. Mason grants each one; the developer gets their own login, never a shared password.
- **The developer's independent review** of security, money paths and operations before rollout. Its must-fix items go in front of Phase D.

**Done when:**
- the developer follows the docs from a clean setup and runs the acceptance tests;
- they make one safe change through the protected delivery process;
- they diagnose an integration failure and complete an isolated recovery exercise;
- their must-fix list is fixed and rechecked, and they sign off in writing;
- launch support, incident response, ongoing maintenance and a backup contact are agreed before Phase D.

### Phase D: Roll out
- Train each role in December and rehearse the cut-over on the test system.
- Chem Man issues its last new bill on **2026-12-31**. Its history stays available, and old-sale returns stay supported.
- **Pilot:** from **2027-01-01**, all billing runs in CRX. The first 30 days are reconciled daily. Each day checks customer balances, payments, credits, stock movements and QuickBooks entries, and every unexplained difference is found and fixed.
- Staff show they can do their normal work and the exceptions: partial deliveries, returns, split billing, failed payments, missing signatures and an outage.
- Mason, the bookkeeper and the senior developer approve the recorded results. No unresolved security, money, inventory or compliance defect is accepted just to hit the date.
- If the pilot turns up a money, stock or compliance defect, it's fixed first. Billing stays in CRX; the fix doesn't wait for the 30 days to end.

**Done when:** the 30-day pilot is signed off, and the spring 2027 season is billed entirely in CRX.

## 6. Open questions

Each answer gets recorded with its owner, the date, and the goal it unlocks.

| # | Question | Recommendation |
|---|---|---|
| 6a | Stay on QuickBooks Desktop long-term, or move to QuickBooks Online? Intuit has been steering new customers to Online, so ask your accountant whether your Desktop version will stay supported. Online is much easier to connect to. | Ask the accountant **now**; the developer weighs in. Goal 7 builds for Desktop unless you decide to move. |
| 6b | When stock runs short, should a delivery warn (today) or be blocked? | Keep warn-only until the L2 stock count is clean, then decide. |
| 6c | Which card/ACH processor? It has to accept an agricultural chemical business and support card and ACH, refunds, returns, reliable notifications and the chosen QuickBooks route. | Pick one and start sign-up **in October**. Compare approval time, all fees, ACH limits, payout timing, reserves, dispute handling and support, not only ACH fees. |
| 6d | Who is the senior developer, what will they charge, and can they hold time for the final review and launch support? | Engage them **in October** for early advice on QuickBooks Desktop, payments and backups. The formal handoff still waits for the finished build and cleanup. |
**Answered 2026-10-14** (now in section 4 and `DECISION_LOG.md`):
- 6e: invoices made from scratch carry no product lines, only service or misc charges.
- 6f: Chem Man's last bill is 2026-12-31.
- 6g: products are billed only when delivered, with advance money recorded as prepay.
- 6h: Mason Wells owns compliance and inventory.
- 6i: an overnight outage is acceptable.
- 6j: only admins change commission splits.
- 6k: the pilot starts 2027-01-01.

## 7. Not doing (parked on purpose)

- Admin-only invoicing (PR #902, closed 2026-10-13).
- Limiting reps to their own customers.
- New safety guards during the freeze, unless a real incident calls for one.
- A grower portal (customers logging in themselves) comes after rollout. A pay-this-invoice link (Goal 7) is not the portal.

## 8. Source evidence

- Claude scalability review plus two Codex `gpt-6-sol` reviews (adversarial and independent), 2026-10-13. Each top finding was checked against live database definitions. One Sol claim, that voiding a delivery cancels other deliveries' drafts, was refuted: it's already fixed live.
- Codex `gpt-6.1-sol` (high reasoning) review of this plan, 2026-10-14, against commit `395bdcd9a`. It made 43 findings; this revision applies them. Before applying, Claude confirmed these in the code:
  - the driver-retry gap;
  - the warn-only RUP check;
  - photo links in the receipt email;
  - starting a stop needs signal;
  - the invoice screen's customer list lacks the price tier;
  - the Goal 2 follow-ups the migration leaves open;
  - no off-site backup job in `.github/workflows/`.

  Claude also confirmed live that the customer-documents service was redeployed on 2026-10-14.
- Mason's answers to 6e–6k and his call that L1–L3 are his own tasks, in chat, 2026-10-14.
- **Evidence status:** code findings refer to commit `395bdcd9a`. Live counts, database size, subscription and recovery settings, deployed services, outside integrations and restore history need a dated live check before anyone relies on them. Measurements here are observations from their stated date, not current guarantees.
- `docs/manual/KNOWN_ISSUES.md` holds the full open-issue list; this doc covers only what moves the $10M goal.
