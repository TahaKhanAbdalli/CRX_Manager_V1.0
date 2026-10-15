# CRX Manager: Direction and Goals (October 2026)

**Owner:** Mason Wells. **Drafted:** 2026-10-13, from the scalability review (Claude, plus two independent Codex Sol reviews). Mason's decisions were recorded the same day.
**Revised:** 2026-10-15, with Mason's answers from an item-by-item walkthrough of Goals 2 and 3 (section 4, the 2026-10-15 rows). Earlier: 2026-10-14, after an independent Codex `gpt-6.1-sol` (high reasoning) review of this plan. Mason asked for that model by name, and the review was advice on the plan, not a ship gate. Ship gates still use the pinned models in `docs/reference/codex-model-tuning.md`, and this docs-only change uses the documentation-only exemption. Claude checked that review's key claims against the code and the live system before applying them.
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
- **Goal 6's test system and backups.** The billing, volume, signal-check and integration proofs in Goals 3–5 and 7 need a safe test system to run on.
- **Goal 7's outside lead times:** the accountant's confirmation that our Desktop version stays supported (6a), the QuickBooks Desktop connection test, and Stripe sign-up and approval (6c). Each can take weeks before any code is written.
- **Lining up the senior developer (6d).**

Sessions can run side by side only when they don't change the same database functions or migrations. Working on different screens is not enough.

**Dates (Mason, 2026-10-14):** Chem Man's last new bill is **2026-12-31**. CRX-only billing starts **2027-01-01**, and the first 30 days are the pilot.

**Timeline risk: this is very tight.** From 2026-10-14 to 2027-01-01 is about 11 weeks. The Phase A estimates add up to roughly 14–25 weeks, plus about a week for the Goal 2 follow-up (its main change shipped; Mason's Supabase billing change takes minutes and is not counted), and cleanup plus handoff add another 4–7. Hitting January 1 needs early decisions, proven integrations, heavy overlap, and the work ordered by what must be ready that day. It is not yet a reliable forecast.

**Checkpoints:**
- **By 2026-10-31:** test system and backup work underway; accountant asked; Stripe sign-up started; senior developer chosen and engaged now for early design reviews of the accounting map, split billing and recovery, not only the December handoff (Mason, 2026-10-15); the "must work on day one" list for 2027-01-01 approved by Mason (Claude drafts it).
- **November–December:** a small real trial. A few chosen customers are billed through CRX instead of Chem Man, quote to payment, with each sale billed in only one system (Mason, 2026-10-15).
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
2. **Billing correctness.** Posting with unsaved edits uses the old amounts. A voided delivery leaves its posted invoice collectible. Some invoice types have no quantity caps. Blend-ticket pricing can pick the wrong price (future work since 2026-10-15), and a product added on the invoice screen ignored the customer's price tier until PR #908 (merged 2026-10-14). Accepting a sent quote re-prices it to today's tier price before it becomes an order, so a price change after sending changes what the customer is billed (confirmed live 2026-10-14; see Goal 3, "Sent quotes keep their prices").
3. **Incomplete data at volume.** Reports, some integrity checks, pickers and list pages stop at 200–2,000 rows.
4. **Weak safety net.** The repo has weekly table snapshots, but they live inside the same database. The architecture doc describes an off-site copy, but no automated job for it exists in the repo, so it needs checking. The free hosting plan has no point-in-time recovery (rewinding the database to a chosen moment). Database backups don't include uploaded files. A test restore has never been done. There's no staging copy (a separate test system), and the browser tests are switched off until one exists.
5. **Completing without signal.** A delivery completed without signal saves no signature image, and starting a field stop needs signal. Goal 5 now makes completion require a signal (Mason, 2026-10-15).
6. **Not yet the system of record.** There's no link to QuickBooks and no online payments.
7. **Not yet launch-ready outside the code.** No compliance sign-off, no physical stock count reconciled to CRX, and no plan for opening balances. Mason handles these himself (L1–L3).
8. **Process cost.** The AI tooling is nearly as large as the app.

## 4. Decisions made (do not reopen)

| Date | Decision |
|---|---|
| 2026-10-13 | **Sales reps may create, post and email invoices for ANY customer**, and see and edit all customers and their related records. This reverses the 2026-10-09 admin-only plan; PR #902 was closed unmerged and never applied. Shipped 2026-10-14 (PR #907). |
| 2026-10-13 | **Reps invoice under their own name only.** A rep can't name another salesperson on an invoice; admins can reassign an invoice's salesperson. That decides who may see and edit the invoice, not who earns commission, which follows the order's or job's split. |
| 2026-10-13 | **Reps read every invoice;** other reps' invoices are read-only to them. Ships as the next change after PR #907. |
| 2026-10-13 | **Upgrade Supabase to the Pro plan with point-in-time recovery** before next season. It's a billing change, so Mason does it. |
| 2026-10-13 | **Photos become private:** delivery, receiving and team-note photos need a sign-in to view. |
| 2026-10-14 | **Chem Man's last new bill is 2026-12-31; all billing runs in CRX from 2027-01-01**, and the first 30 days are the pilot. This replaces "by spring 2027" (2026-10-13). |
| 2026-10-14 | **Product lines are billed only for delivered goods.** Money paid in advance is recorded as prepay. On a field application, chemicals applied count as delivered. |
| 2026-10-14 | **Invoices made from scratch on the New Invoice page carry no product lines,** only service or misc charges. Product sales go through an order and a delivery; a counter sale uses a quick delivery. Field-application, blend-ticket and job invoices keep their chemical lines; they have no order by design. |
| 2026-10-14 | **Only admins change commission splits**: on customers, jobs, quotes and orders. |
| 2026-10-14 | **Sent quotes keep their prices.** The lock covers prices only. Any price change goes through "update to today's prices" in a revision and must be re-sent before it is billed. Bookings stay locked until staff close them, and editing a quote doesn't move its expiry. A cost spike above a locked price needs an admin's below-cost approval at Convert. Details: the pricing plan, `docs/plans/2026-10-13-pricing-history-cost-tracking-and-quote-pricing-PLAN.md`. |
| 2026-10-14 | **Pricing visibility and intake.** Sales reps see the last price charged to a customer but never cost or margin; price history is admin-only. Price changes come in through the full Excel price sheet, which flags moves over 10%, below-cost prices and margins under each product's own floor. Supplier-cost rollout and Early Bird are parked. |
| 2026-10-14 | **An outage may last overnight:** CRX is back up by the next business morning. |
| 2026-10-14 | **Mason Wells owns pesticide compliance and inventory readiness,** and runs L1–L3 himself. They need no code and are not agent-enforced gates. |
| 2026-10-13 | **Everything is built before handoff, integrations included.** Accounting sync and online card/ACH payments are part of Phase A. |
| 2026-10-13 | **The books stay in QuickBooks Desktop** (most company data is there today). CRX syncs to it. Reaffirmed 2026-10-15 (6a). |
| 2026-10-15 | **Stripe is the card and ACH processor** (6c). Its hosted payment page takes the card and bank details, so CRX never stores them. |
| 2026-10-15 | **A stock shortage only warns; it never blocks a delivery** (6b). This is permanent, not an interim policy. |
| 2026-10-15 | **Cost and margin are admin-only.** Sales reps don't see them either, not even on their own invoices and quotes ("this should be admin only"). This replaces the 2026-10-14 Goal 1 answer that reps keep cost and margin, and matches the pricing row above. |
| 2026-10-15 | **Only an admin sets a new customer's commission split.** A customer a rep creates has no split until an admin adds one, and is flagged for the admin so its orders and jobs don't go without commission. Admins get an editor for job and order splits that also recalculates *unpaid* commissions; paid commissions are not changed. |
| 2026-10-15 | **Order and delivery split billing must work now** (Goal 3), including billing a landlord and partly delivered orders. The Order page's "Bill Split" card, which today saves percentages that no bill uses, becomes a working control. **Field-application split billing** (one field invoice shared among customers) and **blend-ticket quote-line pricing** are future work, not Goal 3. |
| 2026-10-15 | **Completing a delivery needs a signal.** Goal 5 shrinks from "full offline proof of delivery" to: without a connection, the app refuses to complete a delivery and says so clearly, so nothing is half-saved. Having signal doesn't guarantee the reply arrives, so Goal 3's retry handling still applies. |
| 2026-10-15 | **No Chem Man work.** Once CRX is in use nothing stays in Chem Man, so Goal 3 builds no Chem Man features. The 53 spring 2026 deliveries already marked "billed outside CRX" stay as they are; the only addition is a narrow block so a return against one can't create a CRX credit (added after the Sol 6.1 review below). |
| 2026-10-15 | **After an independent Codex `gpt-6.1-sol` review of these decisions (advice, not a ship gate), Mason accepted all its recommended changes:** a posted invoice is never cancelled by a void, only credited; a refund paid outside CRX is recorded in CRX; charge lines get a type; ambiguous blend-ticket prices stop for staff to pick; a narrow block stops CRX credits on the 53 Chem Man-billed deliveries; a paper-ticket fallback when there's no signal; new customers go on an admin split to-do list; a small real trial in November–December; a "must work on day one" list; the senior developer engaged now; and an emergency brake for the pilot. |
| 2026-10-15 | **No sales tax is charged on anything.** CRX has no tax and needs none. |
| 2026-10-15 | **Commission already paid on a sale that is later returned or credited is deducted from that person's next payout.** |
| 2026-10-15 | **Goal 2 and 3 details** (recommendations Mason accepted in the 2026-10-15 walkthrough; listed under each goal in section 5): who owns job and blend-ticket invoices, what "read-only" covers, full customer balances for reps, quote splits, list posting, retries, voids, from-scratch charge lines, the field-invoice credit, the quick-delivery improvements, and the split-billing rules. |
| 2026-10-13 | **All AI tooling is kept at handoff** and documented for the developer (Goal 9). |
| 2026-10-07 | **Returns on Chem Man-billed deliveries stay allowed**, with the credit handled in Chem Man or the books. |
| 2026-10-13 | The scalability review's verdict: **strong foundation, no rewrite; not yet ready for $10M.** |

## 5. Goals, in order

Each goal has a plain test for "done". That test is the **minimum**: each goal's own pull request turns it into exact test cases, covering every role, path and failure case it touches, and those are reviewed with the code. Sizes are rough agent-build estimates, not promises. "Live checks" and "staging" tests run on a real database: the live system for read-only and permission checks, a copy for anything that creates money or stock records.

### Phase A: Build

#### Goal 1: Close the security holes (about 1–2 weeks)
- Only admins can pull the restricted-use register.
- Photos require an active staff sign-in to view.
- **Cost and margin are admin-only** (Mason, 2026-10-15): sales reps, drivers and applicators can't read product cost or margin anywhere, including on a rep's own invoices and quotes. This replaces the 2026-10-14 answer that reps keep cost and margin. Applicators only see fields for their assigned jobs.

**Done when:** separate checks, one per rule and identity, all pass. Read-only access and refusal checks run on live. Anything that writes runs on the isolated test system (Goal 6), unless Mason approves a specific live test in that conversation. That includes new uploads, previews, printed documents, deactivating an account, and ending an assignment.
- an admin can pull the register, and a sales rep, driver and applicator are each refused;
- for each of the three photo buckets (`delivery-photos`, `receiving-photos`, `team-note-attachments`): old public links stop working; viewing a photo needs an active, authorized staff sign-in every time, so a copied link alone grants nothing; a signed-out visitor and a deactivated account are each refused; existing photos, new uploads, previews and printed documents still work for staff. An expiring "signed" link does **not** meet this on its own, because anyone holding it can open it until it expires;
- customer delivery receipts keep working without exposing private staff-photo links. Today's receipt email embeds the photo links directly (`src/lib/deliveryCompletionEmail.ts`), so this has to be redesigned along with the photo change;
- a sales rep, a driver and an applicator are each refused cost and margin data, while an admin can read it;
- an applicator sees fields for their assigned jobs and is refused other fields. Ending the assignment removes the access without breaking legitimate field work.

The checks test the server, not just hidden screens: direct table reads, views, exports, files and callable database functions, each tried as every role, a signed-out visitor and a deactivated account. That includes every cost-bearing source and every field reached through a job, a location dispatch or a crew.

#### Goal 2: Reps invoice any customer, under their own name. MAIN CHANGE SHIPPED 2026-10-14
PR #907 merged and its migration (`20261013220000_reps_work_any_customer`) was applied live on 2026-10-14. Reps now find, read and edit all customers and related records, and save and post manual invoices and invoice groups for any customer under their own name. Only admins reassign customers. The customer-documents service was redeployed on 2026-10-14 (version 2).

**Still to do (the "Invoice work continuation" session's follow-up change; about 1 week; due 2026-11-30, before the December developer review):**
- **Own-name everywhere.** The own-name rule also covers invoices generated from orders (single and split; that part is live since 2026-10-15 via `20261014210000_order_invoices_rep_own_name`, PR #928, where a blank salesperson takes the order's salesperson only when that is the rep or no one, except a completed delivery's automatic split, which keeps the order's), the salesperson a rep records on orders and blend tickets and the invoices billed from a blend ticket (live since 2026-10-15 via `20261015130000_orders_blend_tickets_rep_own_name`, PR #933: a rep names themselves or no one, and fills a blank only with their own name), the salesperson a rep records on a quote (Mason, 2026-10-15; `20261015200000_quotes_rep_own_name`, pending apply; season rollover keeps the original rep), and every path a rep can use to edit, unpost, consolidate or transfer an invoice. Taking payments and applying prepay or credits keep working under their current rules.
- **Reps read every invoice,** with other reps' invoices read-only. Until then, a customer balance a rep sees may count only that rep's invoices. It must be labelled as such and never treated as the customer's full balance or credit exposure.
- **Only admins change commission splits** (Mason, 2026-10-14), on customers, jobs, quotes and orders. This tightens what shipped: today a customer's assigned rep may edit that customer's default split, and any active rep can edit a job's split.

**Decided 2026-10-15 (Mason's walkthrough; a code check of 7cd781f77 found the gaps each answer closes):**
- **Back doors to close.** Today a rep can unpost another rep's invoice or invoice group, edit another rep's single field-app invoice, change another rep's field-invoice billing details or applied info, and send another rep's job invoice back to scheduling and re-invoice it as their own. All of these get the own-name check.
- **Job invoices** record the rep who creates them as the salesperson; today no salesperson is recorded.
- **Blend tickets:** a rep can only name themselves as a ticket's salesperson.
- **Invoices no rep owns** (made by an admin, or by a rep who has left) can only be changed by admins, and admins reassign them.
- **Read-only** for another rep's invoice means edit, post, unpost, transfer and adding lines are refused; viewing, printing and re-emailing are allowed.
- **Payments, prepay and credits** may be applied to any of the customer's invoices, including another rep's. The money belongs to the customer's account.
- **Full balances, not labels.** Once reps read every invoice, every balance a rep sees covers the whole customer. That includes Reports → Customer Balance, the printable Customer Invoice Summary a rep can hand a customer, and the payment-allocation screen.
- **Cost and margin** stay hidden from reps on every invoice (section 4).
- **Quote splits.** A rep's new quote takes the customer's split, and the rep can't change it. A duplicated or rolled-over quote takes the customer's *current* split, not the old quote's.
- **New customers** get no split until an admin sets it. They go on an admin to-do list, kept separate from customers deliberately set to no commission. When the admin sets the split, the app offers to apply it to that customer's open quotes, orders and jobs whose commissions are still unpaid, because later splits are not inherited automatically. The offer also covers work already completed before the split was set, which may have made no commission at all (a quick delivery or job copies the customer's empty split), so no completed, unpaid sale is left without its commission; a test covers it. Admins get an editor for job and order splits that recalculates unpaid commissions, showing the old split, the new one and the reason (section 4). Commissions that are still pending but already in a payout batch are refused until that batch is voided, and the change is serialized with payout creation in PostgreSQL. A test covers a split edit racing a payout.
- **Billing splits** (who pays) are not commission splits and stay as they are.

**Done when:** a rep account does all of the following for two customers, one with no assigned rep and one assigned to a different rep. Every step that saves, posts, emails, unposts, changes a split or touches a document runs on the isolated test system (Goal 6), including the attempts that are expected to be refused: if a guard were missing, a "refused" attempt on live would really change customer balances, commissions or documents. The live system is used only for read-only checks, unless Mason approves a specific live test in that conversation.
- finds the customer when invoicing;
- saves, posts and emails both a single invoice and an invoice group (split invoice) to them;
- is refused when naming someone else as salesperson, through the screens **and** direct server calls, on repeat requests, and on an invoice group with mixed owners. A blank or missing salesperson is not refused: on a manual invoice it is filled in with the rep's own name (shipped behavior); on an invoice made from an order it takes the order's salesperson, and is refused when that is another rep, except in a completed delivery's automatic split (`20261014210000`, Mason 2026-10-14);
- is refused when changing any commission split, while an admin can;
- can read another rep's invoice but cannot change it, unpost it, or alter its split set;
- can upload, download and remove a document for a customer assigned to another rep, while a deactivated account is refused;
- customer totals reconcile across invoices made by an admin and by two different reps.

Admin reassignment still works throughout.

#### Goal 3: Billing you can trust (about 2–4 weeks)
- **Post uses what was saved and reviewed.** Post refuses while the screen has unsaved changes. The database enforces this, not just the screen: `post_invoice` and `post_invoice_group` check the invoice version the screen loaded and refuse if it changed. That way a save from a second tab or another user can't be posted unseen (see `KNOWN_ISSUES.md`). Group posting checks every member and the group's membership. Posting from a list (the Invoices list, Office Cockpit, Order page) stays. A row changed since the list loaded is refused with a "reload" message, one row at a time (Mason, 2026-10-15).
- **Retries are safe.** A request that may or may not have gone through can be retried. If its quantities, customer, signer or amount changed in between, the retry must not silently reuse the earlier result. This includes the driver-retry gap in section 3. It also covers the field-stop screen, where an error on one stop can make the next stop look completed, and the Deliveries list's complete action, which uses its own request ID. After an uncertain reply, the completion form locks, checks whether the first attempt went through, and shows the driver what was actually saved (Mason, 2026-10-15).
- **Voids and cancellations.** Voiding or cancelling a delivery leaves nothing collectible for the goods on **that delivery**. Charges for the order's other deliveries stay collectible. A warning message alone (today's behavior) does not count. Today a void cancels only *draft* invoices, and a cancel cancels draft and unposted ones. Posted, overdue and paid invoices stay fully collectible, and overdue or paid ones get no warning. Decided (Mason, 2026-10-15):
  - a *draft* or *unposted* invoice for that delivery is cancelled;
  - a *posted* invoice (unpaid, partly paid or paid) is never cancelled, because it may already be with the customer or in QuickBooks. Instead, a credit for exactly that delivery's value is issued automatically. The value is calculated from the original billed lines and what is still reversible, never from today's prices (changed after the 2026-10-15 Sol 6.1 review);
  - a credit on a paid invoice stays on the customer's account for later invoices. Cash refunds stay outside CRX until Goal 7, but a refund paid outside CRX is **recorded** in CRX, so the customer's available credit goes down and can't be spent twice;
  - unpaid commission on the voided goods is reduced. **Commission already paid on a returned or credited sale is deducted from that person's next payout** (Mason, 2026-10-15). The rule applies from launch; doing it automatically can come later, and until then it is a recorded manual adjustment. Paid entries are never rewritten;
  - only admins can cancel a *completed* delivery. Today the server lets a sales rep do it, and only the screen hides it.
- **Quantity caps.** Product lines are billed only for goods actually delivered, and money paid in advance is recorded as prepay (Mason, 2026-10-14). On a field application, chemicals applied count as delivered (see the field-application note under "Invoices made from scratch" below). The cap holds across all of an order's invoices and split children together, including two attempts at once, added lines, returns, credits and restored invoices. The existing ban on mixing whole-order and per-delivery billing stays. Billing before delivery is removed (Mason, 2026-10-15). Today the Order page's "Create Invoice" and up-front split invoices bill the full *ordered* quantity before anything is delivered; no live order-level invoice exists, so nothing live breaks. A quick delivery's draft invoice stays, since it can't post until the delivery is completed.
- **Invoices made from scratch** (a `misc_charge` or `chemical_sale` invoice with no order or delivery behind it: the New Invoice page makes `misc_charge` invoices, and opened without `?type=misc_charge` it defaults to `chemical_sale`) carry **no product lines** (Mason, 2026-10-14, 6e). This holds on every way of creating, editing or importing one, and on direct server calls. Service and miscellaneous charges stay available. Today the New Invoice page can only add catalog products, so Goal 3 adds a charge line. Staff pick a charge type from a short list (freight, application fee, service, other), then add a description and a dollar amount, with no product, cost or tax (Mason, 2026-10-15). The type list keeps charges distinguishable in the books and stops a charge line being used to sell product. A counter sale goes through a quick delivery, which ties the invoice to real goods. Quick delivery is improved in the same change, because today a counter sale takes about 9–12 actions across 3 screens (Mason, 2026-10-15). It will accept quantities below 1 unit, and a "completed now" option will finish the sale on one screen. **Field-application invoices are not covered by this rule:** direct field-app invoices, blend-ticket invoices and completed-job invoices (all stored as `invoices.invoice_type = 'field_application'`) have no order by design (`docs/workflows/QUOTE_TO_DELIVERY.md`, Field Application Workflow) and keep their chemical lines. Job and blend-ticket invoices are capped in the database at the quantity applied on their job or blend ticket, summed across every active invoice for that source (split siblings included), whenever the invoice can still be edited (`draft` or `unposted`; `transfer_job_to_invoice` leaves job invoices `unposted`) and when two saves race. A direct field-app invoice (`/invoices/field-app/new`) has no separate source record: the entry itself records what was applied, so it is not capped against anything. It can be corrected while it is still editable, and after posting it follows the existing rules: unpost it while it is unpaid and its accounting period is open, otherwise a credit is needed, and no governed credit path exists today for a field invoice (credit memos come only from returns, which need an order). Goal 3 must build and test that credit operation in PostgreSQL. Decided (Mason, 2026-10-15): it is admin-only, needs a reason, and allows a partial amount up to the invoice total. It credits money only, since applied chemicals can't be restocked. **Credit memos are not covered either:** return credits are created only by `issue_return_credit` and carry negative product lines by design.
- **Pricing.** A product added on the invoice screen uses the customer's tier (PR #908, merged 2026-10-14; confirm it on the saved invoice and PDF). Making an order from a blend ticket must never price a product at $0 when a tier price is missing. Today `create_order_from_blend_ticket` has no tier-1 fallback. **Moved to future work (Mason, 2026-10-15):** blend-ticket billing that automatically uses the exact quoted line when a quote lists the same product twice. Today it picks one at random, which breaks "sent quotes keep their prices". So Goal 3 adds a small guard: when the quote lists that product more than once, the blend invoice stops and staff pick the price. Also dropped: refreshing prices when an invoice's customer changes. Order-linked invoices can't change customer, field invoices lock it, and from-scratch invoices will carry no products.
- **Split billing of orders and deliveries** (Mason, 2026-10-15: "for regular order and deliveries we have to have the split billing"). Goal 3 must deliver a proven workflow for partly delivered orders shared among customers, in which customer shares add up exactly to the source charge. It does not exist yet. Today:
  - splitting to a landlord always fails (`INVOICE_ORDER_CUSTOMER_LINEAGE_INVALID`; the 2026-10-13 "landlord yes" decision);
  - a partly delivered order can't be split at all;
  - the leftover cent goes to whichever record ID sorts first;
  - the Order page's "Bill Split" card saves percentages (`order_shares`) that no bill reads.

  Decided:
  - a split can bill a landlord without opening the general customer-lineage check;
  - the "Bill Split" card becomes a working control;
  - each owner's share is frozen at the first delivery, and the last delivery bills exactly what is left;
  - the leftover cent goes to the order's own customer;
  - co-owners pay the order's price, not their own tier;
  - an order that will never be fully delivered can be closed short, then split on what was actually delivered.

  The Bill Split customer-list fix (PR #909) merged on 2026-10-14. **Not in Goal 3:** split billing of field-application invoices (one field invoice shared among customers, including multi-customer blend tickets) is future work.
- **Old Chem Man sales: no Chem Man features** (Mason, 2026-10-15: once CRX is in use, nothing stays in Chem Man). Returns stay allowed as they are today (2026-10-07). One narrow block is added: a return against one of the 53 deliveries marked "billed outside CRX" can't produce a CRX credit, because CRX never billed that sale.
- **Sent quotes keep their prices** (Mason, 2026-10-14). Accepting and converting a quote bill the prices the customer was sent, not today's tier price, and the database enforces this. A price-list change reaches a sent quote only when someone picks "update to today's prices" (per line or for the whole quote) in a revision. Any revision that changes a price must be re-sent before it can become an order or be partly drawn, and the order then uses the newly sent prices. The quote screen also offers a rewind to the version last sent, except on a booking that has ever been partly drawn (an existing safety rule). This is slice 2 of `docs/plans/2026-10-13-pricing-history-cost-tracking-and-quote-pricing-PLAN.md`, which holds the details: matching lines on revised quotes, rewinds, tier changes and partly drawn quotes.

**Done when:** each case is run against a real database copy and refuses or corrects as described. That includes these cases:
- **Posting:** unsaved price, quantity, customer and charge edits; a second tab and a second user saving just before Post; a changed or added split sibling; and every single, group and batch posting route. Credit and RUP checks use the same saved data that gets posted. Leaving a screen with unsaved edits warns first. An uncertain reply can be recovered without posting twice.
- **Voids and cancellations:** both voiding and cancelling, against draft, posted, overdue, partly paid and fully paid invoices, with whole-order and split billing, discounts, and earlier returns and credits. A refund recorded as paid outside CRX lowers the customer's available credit exactly once. On an order with several deliveries, voiding one removes only that delivery's value and the rest stays collectible. Repeat or simultaneous requests never restock, credit or refund twice.
- **Caps and orderless invoices:** a second invoice that would exceed the order's allowance is refused, including when the first was split. A from-scratch invoice with a product line is refused, on both save and post, for both `misc_charge` and `chemical_sale` types, while one with only service or misc charges still saves and posts. A normal order-backed return credit (`credit_memo`) with product lines still issues. Field-app, blend-ticket and job invoices with chemical lines still save and post. Editing a job or blend-ticket invoice in either `draft` or `unposted` status to bill more than its source applied is refused, counting every active invoice for that job or blend ticket together; two siblings that each stay under the total but together exceed it are refused, including when saved at the same moment. The cap counts what is actually billed, not just the applied-quantity field: a product that is not on the job or blend ticket has zero allowance and is refused, and a job line's quantity (written as 1 by `transfer_job_to_invoice`, with the amount in `total_applied`) is either locked at 1 or multiplied into the amount checked, so raising it cannot double the charge. A posted direct field-app invoice can be unposted only while it is unpaid and its period is open; otherwise the correction goes through the new field-invoice credit operation Goal 3 builds.
- **Pricing:** a product added on the invoice screen keeps the customer's tier price on the saved invoice and the PDF; an order made from a blend ticket never prices a product at $0.
- **Quote prices:** a tier price changes after a quote is sent; accepting and converting it still puts the sent prices on the order, invoice and PDF. A revision that changes a price is refused at Convert until it is re-sent, then bills the new prices. Revise-then-convert, rewind-then-convert and "update to today's prices" each pass the cases listed in the pricing plan's slice 2.
- **Split billing:** a landlord split, "Bill Split" percentages, partly delivered and per-acre splits, several delivery dates, a short-closed order, final remainders and returns, with every quantity and cent accounted for and the leftover cent on the order's own customer.
- **What the customer actually receives:** the office and bookkeeper review real printed and emailed invoices, split invoices, credits, statements and delivery receipts. They check recipient, address, product and unit, price, discounts, that no sales tax appears, due date, payment instructions and final balance, including long and corrected documents, season boundaries and aging cutoffs. A failed email stays visible and can be retried without billing twice.

**Notes for the Goal 3 build** (from the PR #932 review; the goal's own PR designs and tests each):
- **Field-invoice credits are capped cumulatively.** All credits on one invoice together can't exceed what is still creditable. Two credits at once are serialized in PostgreSQL, and repeat and simultaneous credit attempts are tested.
- **The paid-commission deduction needs a lasting record in CRX.** Today `create_commission_payment` pays pending rows at their full amount, and paid rows stay as history. So the deduction is a negative adjustment that the next payout and the commission reports both include, not just a smaller outside check. A test proves both see it. A payout never goes below zero, and today's payout check refuses negative lines, so a deduction larger than the next payout carries the rest forward to later payouts until it is used up. If the person has left, the remaining amount stays visible to admins as owed, and is never silently forgiven. Tests cover a deduction spread over several payouts and one for a person who has left.
- **Split shares freeze the money, not just the percentages.** At the first delivery, the split also freezes each line's billed total after discounts, its price, acres and owners. After that, a change to any of them is refused, or made as a recorded adjustment, so the last delivery's remainder is figured on the same basis as the first. Tests cover a discounted line and an edit in the middle of delivering. Closing an order short settles the frozen amounts in the same PostgreSQL step: the undelivered part is retired, and only goods delivered but not yet billed are split and billed. That way the closing bill never charges for undelivered goods and leaves no unbilled leftover. A test closes an order short after an earlier split delivery.
- **The Chem Man credit block needs to know the delivery.** Returns record only the order and order line, while the "billed outside CRX" record is per delivery. A return must therefore name, or be allocated to, its delivery. One test case is an order line delivered partly in a Chem Man-billed delivery and partly in a CRX-billed one, so a legitimate CRX credit isn't blocked and the Chem Man quantity isn't credited.
- **Returns on split orders credit each payer for their own share.** When goods billed partly to the grower and partly to a landlord come back, each payer is credited for their share of those goods, taken from their original invoice lines, not the order customer alone. Today a return has one customer, and `issue_return_credit` refuses quantity billed to another split customer (`RETURN_CREDIT_SPLIT_CUSTOMER_SOURCE_REQUIRES_LINEAGE`). A PostgreSQL test covers a partial return on a grower/landlord split.

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

Matching a sum is not enough on its own, because a report can add up the wrong rows. The bookkeeper also approves what each financial report means: which statuses count, the date basis, returns, credits, prepay, write-offs and costs (no sales tax is charged; Mason, 2026-10-15). Results are compared with independently prepared expected answers, including customers or products with the same name, renamed records, closed seasons and Chicago date boundaries. Profit reports use the cost-snapshot data, not today's product costs.

**Workload test:** estimate the busiest day's users, deliveries, invoice lines, uploads and accounting and payment events. Run twice that on staging while reports and syncs run. Agree response-time targets before the test, and record slow spots and errors.

#### Goal 5: Completing a delivery needs a signal (a few days; narrowed 2026-10-15)
Mason, 2026-10-15: "we should just be connected to internet to make sure no errors like this happen." Full offline proof of delivery (signature, photos and receipt syncing on reconnect) is dropped. Instead:
- without a connection, every delivery completion path refuses to complete and tells the driver plainly to get signal and try again. That covers the delivery page, the field stop, and the Deliveries list's complete action (`src/pages/Deliveries.tsx`), which confirms a scheduled delivery before calling `complete_delivery`. Nothing is half-saved: a scheduled delivery is never left confirmed to `in_progress` by a completion that failed for lack of signal, and no completion is queued to sync later;
- **paper fallback** (Mason, 2026-10-15): with no signal at the customer, the driver gets a paper delivery ticket signed on site. Once back in signal, the driver completes the delivery in the app with a photo of the signed ticket. The app never captures a signature after the fact;
- the lost-reply case, where the phone had signal but the answer never came back, is handled by Goal 3's "Retries are safe".

**Done when:** on the supported phones and installed app, in airplane mode, each of the three completion paths (delivery page, field stop, Deliveries list) refuses with a clear message and leaves the delivery's status, stock and billing unchanged. That includes a scheduled delivery losing signal between the list's confirm step and its completion. Back online, the same completion succeeds once, with its signature, photos and customer receipt. On the paper-ticket path, the photo of the signed ticket takes the place of the signature image; the signer's name, the photo and the customer receipt are still required, and no signature is drawn after the fact. A completion already queued offline before this change ships is either synced safely or shown to the office; it is never lost.

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
  - finance charges and discounts. No sales tax is charged on anything (Mason, 2026-10-15); the map records that;
  - processor fees, inventory costs, and vendor bills and payments;
  - commissions.

  For each one, name which system creates it, which may correct it, and how it reaches the other. Nothing is entered in both. Include the chart-of-accounts mapping and the rules for closed periods.
- **Online card and ACH payments,** through **Stripe** (Mason, 2026-10-15). Use Stripe's own hosted payment page. At sign-up, confirm that Stripe approves an agricultural chemical business and supports the ACH volume we need; CRX never stores card or bank numbers. A payment link only lets the customer pay that invoice; it is not the grower portal. An invoice is marked paid only on a verified processor event, never because a browser showed a success page. Name which processor event counts as "settled", and how later bank deposits and fees reconcile.
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

A shortage only warns and never blocks a delivery (Mason, 2026-10-15, 6b; permanent, do not reopen). Every shortage still has someone assigned to deal with it.

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
- If the pilot turns up a money, stock or compliance defect, it's fixed first, and the fix doesn't wait for the 30 days to end. **Emergency brake** (Mason, 2026-10-15): the affected operation can be paused and run on numbered paper records until the fix ships, then entered and reconciled. Everything else stays in CRX, and Chem Man is not restarted as a second billing system.

**Done when:** the 30-day pilot is signed off, and the spring 2027 season is billed entirely in CRX.

## 6. Open questions

Each answer gets recorded with its owner, the date, and the goal it unlocks.

| # | Question | Recommendation |
|---|---|---|
| 6d | Who is the senior developer, what will they charge, and can they hold time for the final review and launch support? Not known yet (Mason, 2026-10-15). | Engage them **in October** for early advice on QuickBooks Desktop, payments and backups. The formal handoff still waits for the finished build and cleanup. |

**Answered 2026-10-15** (now in section 4 and `DECISION_LOG.md`):
- 6a: stay on QuickBooks Desktop (Mason: "we will stay with desktop quickbooks i imagine"). Goal 7 builds for Desktop. Still ask the accountant to confirm our Desktop version stays supported, since Intuit has been steering customers to Online.
- 6b: a stock shortage only warns and never blocks a delivery. Permanent.
- 6c: Stripe is the card and ACH processor.

**Answered 2026-10-14** (now in section 4 and `DECISION_LOG.md`):
- 6e: invoices made from scratch on the New Invoice page carry no product lines, only service or misc charges. Field-application, blend-ticket and job invoices are not covered.
- 6f: Chem Man's last bill is 2026-12-31.
- 6g: products are billed only when delivered (chemicals applied on a field application count as delivered), with advance money recorded as prepay.
- 6h: Mason Wells owns compliance and inventory.
- 6i: an overnight outage is acceptable.
- 6j: only admins change commission splits.
- 6k: the pilot starts 2027-01-01.

## 7. Not doing (parked on purpose)

- Admin-only invoicing (PR #902, closed 2026-10-13).
- Limiting reps to their own customers.
- New safety guards during the freeze, unless a real incident calls for one.
- A grower portal (customers logging in themselves) comes after rollout. A pay-this-invoice link (Goal 7) is not the portal.
- **Future work, not Phase A** (Mason, 2026-10-15):
  - blend-ticket billing that uses the exact quoted line when a quote lists the same product twice;
  - split billing of field-application invoices (one field invoice shared among customers, including multi-customer blend tickets);
  - full offline proof of delivery (Goal 5 now requires a signal);
  - Chem Man features for old sales, beyond the narrow credit block in Goal 3.

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
- **Evidence status:** code findings refer to commit `395bdcd9a`, except the 2026-10-15 Goal 2 and 3 walkthrough facts, which refer to `7cd781f77`. Live counts, database size, subscription and recovery settings, deployed services, outside integrations and restore history need a dated live check before anyone relies on them. Measurements here are observations from their stated date, not current guarantees.
- `docs/manual/KNOWN_ISSUES.md` holds the full open-issue list; this doc covers only what moves the $10M goal.
