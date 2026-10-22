# Day one: what must work on 2027-01-01 (DRAFT for Mason's approval)

**Owner:** Mason Wells approves. **Drafted:** 2026-10-21 by Claude, as asked in `docs/plans/2026-10-13-direction-and-goals.md` section 2 ("must work on day one" list, checkpoint 2026-10-31).
**Reviewed:** an advisory Codex `gpt-6-sol` (high) review of the first draft, 2026-10-21. It made 57 findings. Claude checked each against the goals doc and the code. Most were applied; the few that weren't are listed at the end, with the reason.
**Status:** DRAFT, waiting on Mason. Nothing here authorizes building anything. Each item is built through its own goal and pull request.
**Evidence date:** every "today" status was checked against `main` at `d720cf681`, the open PR list and the open-issue list on 2026-10-22 (first checked at `e0b5d4234` on 2026-10-21, then refreshed after the Codex GitHub review on this PR). Statuses go stale quickly; re-check before relying on one. "Open PR" means written and in review, not live.

---

## What this list is for

On **2027-01-01** Chem Man stops billing, and every quote, order, delivery, invoice and payment runs in CRX. The first 30 days are the pilot. This list says what has to be true that morning, so the next ten weeks go to the right work.

Words used below:
- **Posting** an invoice locks it as a real bill the customer owes.
- **Retry-safe** means that if the phone loses its connection mid-save and someone taps again, nothing is saved twice or saved wrong.
- **Staging** is a separate test copy of CRX, with fake money and email, where we can try anything without touching real customers.
- **PR** is a pull request (one reviewed change to the app). A **migration** is a reviewed change to the database.

## How each item is ranked

- **MUST**: without it, January 1 risks a wrong bill, a lost record, a wrong regulated record, or a bad day we can't recover from by the next business morning. It also covers anything the goals doc makes a launch gate (the November–December trial, staging proofs, the developer's sign-off). Each MUST is either done and proven by mid-December, or covered by a written, rehearsed fallback Mason approves, or the date moves.
- **SHOULD**: a written manual step covers it safely for the 30-day pilot, and a named person runs that step.
- **CAN-WAIT**: Mason parked it, or it can't come up before the season changes on October 1, 2027 or at January's volume.

**Status words.** *Built* means the code is live but hasn't yet passed its goal's full test. *Proven* means it has. *Not built* means no shipped change exists. *Process* means a written business procedure, not code.

**What "done" means for each row.** The one-line description here is a summary. The real test is that goal's full "Done when" list in the goals doc, run on staging. For example, split billing's test includes discounts, per-acre splits, several delivery dates and repeat requests. Each goal's own PR turns that list into exact test cases.

## The short version

| | Count |
|---|---|
| MUST, built and live (still needs its December proof) | 19 |
| MUST, code not built or only partly built | 30 |
| MUST, a business process, drill, review or Mason action (not code) | 26 |
| SHOULD | 3 |
| CAN-WAIT | 4, plus the parked items in section 17 |

Rows that only point to another row ("See 4.4") aren't counted twice. A row split between two ranks (for example 8.3) counts under its MUST part.

**The four biggest risks for January 1:**
1. **Billing correctness (Goal 3) is about half built.** Split billing, voids on posted invoices, quote price locks, return credits on split orders and "post uses what was saved" are open or in progress.
2. **We can't yet recover from losing the database (Goal 6).** The weekly off-site copy runs, but it has never been restored, photos aren't backed up, and the Supabase plan can't rewind to a chosen time. Today a bad day could cost about a week of work.
3. **No staging system yet.** Nearly every proof below, plus the December rehearsal and staff training, needs one.
4. **The QuickBooks and Stripe connections haven't started, and Stripe may not accept a restricted-use pesticide seller at all.** If they aren't proven by 2026-12-15, January runs on manual procedures that aren't written yet.

---

## 1. Selling: quotes and orders

| # | What must work | Today (evidence) | Closed by | Rank |
|---|---|---|---|---|
| 1.1 | Build, send and convert a quote; a rep records only their own name on it | **Built.** Quote builder, versions and PDFs live. Own-name on quotes live since 2026-10-15 (PR #938, migration `20261015200000`). | Done; prove on staging | MUST |
| 1.2 | **A sent quote keeps the prices the customer saw.** A price change goes through a revision that must be re-sent; rewind to the last sent version; an admin approves a below-cost price at Convert | **Not built.** Accepting a sent quote re-prices it to today's tier price (confirmed live 2026-10-14; goals doc section 3, gap 2). | Goal 3, pricing plan slice 2 | MUST |
| 1.3 | Convert to Order never leaves an accepted quote with no order; re-saving a quote with one product on two lines works | **Open, latent** (`KNOWN_ISSUES.md`, "quote screen: re-saving a quote with two lines of one product is refused", 2026-10-13). An accepted quote with no order can lose a sale without anyone noticing. | Goal 3 (same area as 1.2) | MUST |
| 1.4 | Create an order; a rep records only their own name on orders and blend tickets | **Built.** Live since 2026-10-15 (PR #933, migration `20261015130000`). | Done; prove on staging | MUST |
| 1.5 | **Only admins change commission splits** (customers, jobs, quotes, orders). New customers go on an admin to-do list. Copied and rolled-over quotes take the customer's current split. An admin editor recalculates *unpaid* commissions and can't race a payout | **Not built.** Today a customer's assigned rep can edit that customer's split, and any rep can edit a job's split (goals doc, Goal 2 "Still to do"). Due 2026-11-30. | Goal 2 follow-up | MUST |

## 2. Delivering

| # | What must work | Today (evidence) | Closed by | Rank |
|---|---|---|---|---|
| 2.1 | Completing a delivery from the delivery page, the field stop or the Deliveries list. With no signal the app refuses and changes nothing; back online it completes once | **Built, not proven on a real phone.** Refusal and paper-ticket fallback live (PR #955); the Deliveries list does it in one step (PR #964, migration `20261019220000`). The airplane-mode test on a supported phone hasn't been done (Goal 5, "Still open" item 4). | Goal 5 | MUST |
| 2.2 | Paper ticket when there's no signal: the driver gets it signed, then completes in the app with a photo of it | **Built in the app**, which requires the photo once the paper-ticket box is ticked. The database doesn't require the photo or record that a paper ticket was used (Goal 5, "Still open" item 2). Open PR #1024 makes the server check completion proof. | Goal 5 follow-up | MUST: the real-phone test. SHOULD: the database check |
| 2.3 | **Completions and money actions are retry-safe** | **Partly built.** Four batches live (last applied 2026-10-21). **69 database functions still open** (`KNOWN_ISSUES.md`, "about 75 live functions replay a saved result matched on the retry key alone"). The driver-retry gap in goals doc section 3 is part of this. | Goal 3 ("Retries are safe") | MUST |
| 2.4 | Customer gets a delivery receipt email | **Built, with gaps.** The phone sends it, and doesn't retry if signal drops right after. A driver who can't see an older stop's customer sends no receipt, and on the normal signature path isn't told (`KNOWN_ISSUES.md`, "a driver's completion receipt can be skipped", MED). The office can resend. Receipts carry no photos (Mason, 2026-10-14). Open PR #1024 also covers driver receipts. | Goal 5 follow-up | SHOULD (the office resend covers it, see 9.3) |
| 2.5 | A counter sale through quick delivery in a few taps, including amounts under 1 unit | **Not built** (goals doc, Goal 3: today 9–12 actions across 3 screens). Counter sales still work, just slowly. | Goal 3 | SHOULD |
| 2.6 | A stock shortage warns but never blocks a delivery | **Built.** Mason's permanent decision (2026-10-15, 6b). | Done | MUST |

## 3. Billing: invoices

| # | What must work | Today (evidence) | Closed by | Rank |
|---|---|---|---|---|
| 3.1 | **Post bills exactly what was saved and reviewed**, on every route: single, group, batch and list posting. Credit and restricted-use (RUP) checks use the same saved version | **Open.** Today Post sends the *old* saved amounts and drops the on-screen edits (`KNOWN_ISSUES.md`, "the regular invoice editor posts the old saved amounts", 2026-10-09). **Fix written:** open PR #1018 (migration `20261021200000`). | Goal 3 | MUST |
| 3.2 | Product lines are billed only for delivered goods, across all of an order's invoices together (split siblings, added lines, returns, credits, restored invoices, two saves at once). Billing before delivery is removed | **Partly built.** A delivery's invoice is capped at what was delivered (migration `20261010120000`, PR #889). Order-level "Create Invoice" and up-front splits can still bill the ordered amount before delivery (goals doc, Goal 3 "Quantity caps"). No shipped fix found. | Goal 3 | MUST |
| 3.3 | Invoices made from scratch carry only charge lines (freight, application fee, service, other) | **Built.** Live 2026-10-21 (PR #983, migration `20261021050000`). | Done; prove on staging | MUST |
| 3.4 | A product added on the invoice screen uses the customer's price tier | **Built** (PR #908, 2026-10-14). The goals doc asks for one check on a saved invoice and its PDF. | Goal 3 (one check) | MUST |
| 3.5 | **Voiding or cancelling a delivery leaves nothing collectible for that delivery**: a draft or unposted invoice is cancelled; a posted one (unpaid, partly paid, paid or overdue) gets an automatic credit for exactly that delivery; the order's other deliveries stay collectible; repeats never restock or credit twice; only admins cancel a completed delivery | **Mostly not built.** A posted invoice stays fully collectible after its delivery is voided (`KNOWN_ISSUES.md`, "Voiding a delivery whose invoice is already posted leaves that invoice active"). A sales rep can cancel a completed delivery through the server. Built so far: voiding an order with split drafts (PR #987, migration `20261021030000`, live 2026-10-21), and cancel/void retry-safety (batch 3b). | Goal 3 ("Voids and cancellations") | MUST |
| 3.6 | **Reps read every invoice.** Another rep's invoice is view, print and re-email only, with no edit, post, unpost, transfer or added lines. Invoices nobody owns are admin-only. Every balance a rep sees covers the whole customer (Customer Balance report, printed Customer Invoice Summary, payment-allocation screen) | **Not built.** Reps can still unpost or edit some other reps' invoices (goals doc, Goal 2 "Back doors to close"). Due 2026-11-30. | Goal 2 follow-up | MUST |
| 3.7 | A rep invoices only under their own name on every path: splits, groups with mixed owners, list posting, unposting, consolidation, transfer. Admins can reassign | **Partly built.** Manual, order and blend-ticket invoices are live (PRs #907, #928, #933). Job invoices don't record a salesperson yet (goals doc, Goal 2). | Goal 2 follow-up | MUST |
| 3.8 | Invoice numbers take Chicago's year | **Built.** Live 2026-09-21 (migration `20260914100100`). | Done | MUST |

## 4. Split billing (one sale billed to more than one customer)

Mason, 2026-10-15: "for regular order and deliveries we have to have the split billing."

| # | What must work | Today (evidence) | Closed by | Rank |
|---|---|---|---|---|
| 4.1 | Split an order or delivery between the grower and a landlord, partly delivered orders included. Co-owners pay the order's price. Every cent is accounted for, and the leftover cent goes to the order's own customer | **In progress.** Today splitting to a landlord fails and a partly delivered order can't be split (goals doc, Goal 3 "Split billing"). Open PRs: #1006 and #1010. | Goal 3 | MUST |
| 4.2 | The Order page's "Bill Split" card drives the bills | **Not built.** It saves percentages that no bill reads. | Goal 3 | MUST |
| 4.3 | At the first delivery the split freezes the *money*: each line's billed total after discounts, its price, acres and owners. The last delivery bills exactly what's left. An order can be closed short and split on what was delivered | **Not built** (goals doc, Goal 3 build notes). | Goal 3 | MUST |
| 4.4 | A return on a split order credits each payer for their own share, from their original invoice lines | **Not built.** A return has one customer today, and the database refuses quantity billed to another split customer. | Goal 3 | MUST |
| 4.5 | Splitting one *field-application* invoice among customers | **Not built, on purpose.** Parked by Mason 2026-10-15. | Future work | CAN-WAIT |

## 5. Field-application, job and blend-ticket invoices

| # | What must work | Today (evidence) | Closed by | Rank |
|---|---|---|---|---|
| 5.1 | Create, post and print field-app, job and blend-ticket invoices with their chemical lines | **Built** (goals doc, Goal 3: these keep their chemical lines by design). | Done; prove on staging | MUST |
| 5.2 | Blend tickets never price a product at $0 for a missing tier price. Staff pick when a quote lists one product twice. A $0 line needs an admin reason | **Built.** Live 2026-10-21 (PR #982, migration `20261020210000`; PR #995, migration `20261021070000`). | Done; prove on staging | MUST |
| 5.3 | A job or blend-ticket invoice can't bill more than was applied, counting every invoice for that job or ticket, including two saves at once | **Not built** (goals doc, Goal 3 "Caps and orderless invoices"). | Goal 3 | MUST |
| 5.4 | Correcting a posted field-app invoice with a credit: admin-only, with a reason, partial amounts allowed. All credits on one invoice together can't exceed what's still creditable, and two at once are handled safely | **Not built.** No credit path exists for a field invoice today; credits come only from returns, which need an order. | Goal 3 | MUST |
| 5.5 | The fix that stopped reps making field-app invoices through the order screens is fully signed off | **Fix live since 2026-10-07; two sign-off checks still owed** (`KNOWN_ISSUES.md`, "CRX-LIFE-001"). Item 1's query used to be refused at a confirmation prompt; PR #1013 (merged 2026-10-21) removed that cause, so an agent can now re-run it. Item 2 is a live run of two existing checks. | Agent, minutes each | MUST |
| 5.6 | Blend ticket linked to an order with several price tiers for one product | **Open, no money effect today.** The quantity it records is read by nothing (`KNOWN_ISSUES.md`, "blend-ticket linkage picks ONE order line per product"). It's a separate issue from the duplicate-line pricing in 5.2. | Later | CAN-WAIT |

## 6. Payments, prepay and credits

| # | What must work | Today (evidence) | Closed by | Rank |
|---|---|---|---|---|
| 6.1 | Record a check or bank payment against one or more invoices | **Built.** This is how payments are taken today, and the money loop has completed a real cycle (`CURRENT_STATE.md`, "Reality check"). Retry-safe since batch 1 (PR #942). | Done; prove on staging | MUST |
| 6.2 | Prepay: take money in advance, apply it to invoices, edit it | **Built.** Recent fixes: PRs #992 and #997; an exact retry of a prepay edit proven live (PR #968). | Done; prove on staging | MUST |
| 6.3 | Credits from returns applied to invoices, with reversal | **Built** (credit-memo apply live; `CURRENT_STATE.md` feature map). | Done; prove on staging | MUST |
| 6.4 | **A refund paid outside CRX is recorded in CRX**, so the customer's credit can't be spent twice | **Not built** (goals doc, Goal 3 "Voids and cancellations"). | Goal 3 | MUST |
| 6.5 | Balances and aging use Chicago's date and include every customer, for admins | **Built.** PRs #991, #996 and #998 (2026-10-21). Rep-visible full balances are still open (see 3.6). | Done | MUST |
| 6.6 | A customer's full payment history past 200 entries | **Open** (goals doc, Goal 4 list). Goal 4's done test includes a 200+ payment history, and Goal 4 is a launch gate. | Goal 4 | MUST |

## 7. Returns

| # | What must work | Today (evidence) | Closed by | Rank |
|---|---|---|---|---|
| 7.1 | Return goods on a CRX-billed order and get a credit | **Built** (`issue_return_credit`). | Done; prove on staging | MUST |
| 7.2 | A return against one of the 53 spring deliveries billed in Chem Man can't create a CRX credit | **Not built.** Returns on those are allowed today (`KNOWN_ISSUES.md`, 2026-10-07 entry). The block needs returns to name their delivery. | Goal 3 | MUST |
| 7.3 | Old-sale returns after 2026-12-31: staff know how to accept the goods, issue the credit in Chem Man or the books, and still open Chem Man history | **Process not written** (goals doc, L3; decision 2026-10-07). | Mason (L3) | MUST |
| 7.4 | Split-order returns | See 4.4. | Goal 3 | MUST |

## 8. Commissions

| # | What must work | Today (evidence) | Closed by | Rank |
|---|---|---|---|---|
| 8.1 | Commissions calculated on orders and jobs, and payouts recorded | **Built** (job-level commissions live; commission cohort live 2026-09-21 to 09-28). | Done; prove on staging | MUST |
| 8.2 | Admin-only splits | See 1.5. | Goal 2 follow-up | MUST |
| 8.3 | **Commission already paid on a returned or credited sale comes off the next payout**, as a lasting negative adjustment in CRX that the payout and the commission reports both show. It carries forward if it's bigger than one payout, and stays visible as owed if the person has left | **Not built.** Today `create_commission_payment` pays pending rows at full amount and refuses negative lines (goals doc, Goal 3 build notes). Mason allowed the *calculation* to be manual at first, but it still has to be recorded in CRX. | Goal 3 | MUST: the recorded adjustment. SHOULD: automatic calculation |

## 9. Statements, printed documents and emails

| # | What must work | Today (evidence) | Closed by | Rank |
|---|---|---|---|---|
| 9.1 | Print and email invoices, split invoices, credits, statements and delivery receipts | **Built** (PDFs and the `send-email` service live), with the receipt gaps in 2.4. | Done; review in 9.2 | MUST |
| 9.2 | **The office and bookkeeper review real printed and received documents**: recipient, address, product, unit, price, discounts, no sales tax, due date, payment instructions, final balance. Include long and corrected documents, split credits, season boundaries and aging cutoffs | **Not done** (goals doc, Goal 3 "What the customer actually receives"). | Goal 3 | MUST |
| 9.3 | A failed email is visible, a named office person resends it, and a resend never bills twice | **Partly built.** The office can resend a receipt; there's no guaranteed automatic retry (Goal 5, "Still open" item 3). | Goal 3 / Goal 5 | MUST: visible failure and a proven manual resend. SHOULD: automatic retry |
| 9.4 | Payment instructions on invoices match how customers can actually pay on January 1 (no online-payment link until Stripe is live) | **Process.** No Stripe link exists today, so nothing to remove yet. Recheck if Stripe ships partway. | Goal 7 / Phase D | MUST |
| 9.5 | A PDF over 20 pages is refused plainly rather than cut short | **Built** (PR #993, 2026-10-21). | Done | SHOULD |

## 10. Reports and complete numbers

| # | What must work | Today (evidence) | Closed by | Rank |
|---|---|---|---|---|
| 10.1 | Lists, reports, integrity checks and lookups read every record | **Mostly built.** Goal 4 parts 1, 2a and 2b live (PRs #959, #981, #988, #993). Still open: the dashboard action counts that stop at 10 (H36, part 4), the payment-history limit (6.6), and the old-limit data tests in Goal 4's "Done when". | Goal 4 | MUST |
| 10.2 | **The bookkeeper approves what each money report means** (which statuses count, the date basis, returns, credits, prepay, write-offs, costs), checked to the exact cent against independently prepared answers | **Not done** (goals doc, Goal 4 "Done when"). | Goal 4 | MUST |
| 10.3 | Pickers become search boxes; list pages page on the server | **Open.** Part 3 (pickers) is written: open PR #1017. Part 4 (server-side paging) isn't started. Both are in Goal 4's done test, which the goals doc makes a launch gate (due 2026-12-15). | Goal 4 | MUST |
| 10.4 | Workload test at twice the busiest day, with response-time targets agreed first | **Not run** (Goal 4). Needs staging. | Goal 4 | MUST |

## 11. Security and roles

Four staff roles must each get through a normal day: **admin** (everything), **sales rep** (quotes, orders, invoices, payments), **driver** (deliveries, field stops) and **applicator** (assigned jobs and fields). Commission recipients are paid but don't sign in to work.

| # | What must work | Today (evidence) | Closed by | Rank |
|---|---|---|---|---|
| 11.1 | Only admins pull the restricted-use (RUP) sales register | **Built** (PR #927, migration `20261014220000`). | Done | MUST |
| 11.2 | Photos need an active staff sign-in every time; old and copied links fail; deactivated staff are refused | **Built** (PRs #929 and #947; buckets private since 2026-10-16). Goal 1's full per-bucket, per-role and deactivation checks still have to pass on staging. | Goal 1 | MUST |
| 11.3 | **Cost and margin are admin-only everywhere** | **Mostly live.** Steps 1 and 2 (PR #957; PR #965 with migration `20261019230000`), and purchase-order cost admin-only with locked columns (PR #980, migrations `20261021140000` and `20261021141000`, live 2026-10-22). Still open: step 3, locking cost columns on the other tables, such as product `current_cost` (`KNOWN_ISSUES.md`, HIGH, 2026-10-18). | Goal 1 | MUST |
| 11.4 | An applicator sees only the fields for their assigned jobs, by every route (job, location dispatch, crew), and loses access when the assignment ends | **Not proven.** It's a Goal 1 rule with no shipped check found. | Goal 1 | MUST |
| 11.5 | A rep can't write RUP register rows for an invoice that was never posted | **Open** (`KNOWN_ISSUES.md`, MED, 2026-10-14). It would put false sales in a regulated record. | Goal 1 follow-up | MUST |

## 12. The year boundary (December 31 to January 1)

Checked 2026-10-21: the *season* changes on **October 1**, not January 1 (`src/utils/season.ts`). So the open season-stamp issues in `KNOWN_ISSUES.md` matter at the 2027-10-01 change, not on day one. What does change at midnight on December 31 is the year in document numbers.

| # | What must work | Today (evidence) | Closed by | Rank |
|---|---|---|---|---|
| 12.1 | Quote, order and rebate-claim numbers take Chicago's year | **Open.** They use the server's clock (UTC, six hours ahead of Chicago), so anything created after 6 pm on December 31 gets a 2027 number (`KNOWN_ISSUES.md`, 2026-09-26). Invoice numbers are already fixed (3.8). | New small fix | MUST |
| 12.2 | A year-end rehearsal on staging: entries on both sides of midnight Chicago time, aging and statements as of December 31 and January 1, and documents dated across the line | **Not done.** | Phase D | MUST |
| 12.3 | Season stamps and season reads on the server and browser clocks, including the pre-harvest-interval warning on a job (`KNOWN_ISSUES.md`, "other paths still stamp `invoices.season` from the UTC clock" and "client-side season READS still follow the browser clock, including ONE SAFETY path") | **Open**, but only wrong around October 1. | Fix before 2027-09-30 | CAN-WAIT (for day one) |

## 13. Backups and recovery (Goal 6)

Mason's target: an outage can last overnight, CRX is back by the next business morning, and we lose minutes of work, not days.

| # | What must work | Today (evidence) | Closed by | Rank |
|---|---|---|---|---|
| 13.1 | **Supabase Pro with point-in-time recovery** (rewinding the database to a chosen minute) | **Not done.** The plan is Free (live check 2026-10-18, `docs/plans/2026-10-18-goal-6-safety-net-findings.md`). Already decided 2026-10-13; it needs Mason's billing click. | Goal 6 (Mason's action) | MUST |
| 13.2 | **A full restore drill**, timed and logged: database, permissions, logins and every file bucket restored into an isolated copy, with photos opening against their records; plus one rewind-to-a-time on a throwaway copy, with recovery time and lost work measured against Mason's target | **Not done.** The weekly off-site copy has run every Sunday since 2026-09-06 (last 2026-10-18) but has never been restored. The steps are a draft (`docs/plans/2026-10-19-goal6-restore-procedure-draft.md`). A parallel session is working on Goal 6. | Goal 6 | MUST |
| 13.3 | Photos, signatures and uploads backed up (all nine storage buckets) | **Built, not running.** A weekly file backup for every bucket was written on 2026-10-21 (`CRX_Backups` PR #1; `docs/operations/production-runbook.md`, storage row). It waits on Mason adding two storage keys as secrets, and on that PR merging. Until its first run succeeds, the files have no backup. | Goal 6 | MUST |
| 13.4 | **After a restore, nothing happens twice**: payments, QuickBooks entries and emails already sent are reconciled before anything restarts | **Process not written** (goals doc, Goal 6 "Done when"). | Goal 6 | MUST |
| 13.5 | Two named people can run the recovery; the backup passphrase isn't held by Mason alone | **Not done.** Only Mason holds the passphrase. | Goal 6 (Mason names them) | MUST |
| 13.6 | A failed backup alerts a named person and a backup, who know what to do | **Partly built, not live.** A daily freshness check that fails when a backup is too old was written on 2026-10-21 (`CRX_Backups` PR #1; runbook section 4.11). It only reaches Mason if GitHub emails him about failed runs, which isn't confirmed yet. The outside watchdog, which still works if GitHub Actions stops, isn't built. Until then, someone checks the backup dates every Monday. A silent failure would quietly break the "minutes, not days" target. | Goal 6 | MUST |
| 13.7 | **Staging**: a separate copy of CRX with its own accounts, test payment keys and captured email, which can't reach real systems. The money and inventory browser tests run per role on it, and a failure blocks the change | **Not built.** Almost every proof in this list, the December rehearsal and staff training depend on it. | Goal 6 | MUST |

## 14. QuickBooks and Stripe

Both integrations stay in the plan (Goal 7). Nothing exists in the code yet: searching `src/` and `supabase/functions/` on 2026-10-21 found no QuickBooks or Stripe code. A research plan landed on 2026-10-21 (`docs/plans/2026-10-21-goal7-quickbooks-stripe-groundwork.md`, PR #1016). It recommends testing the paid Conductor connector for QuickBooks first. It also found that **Stripe's prohibited-business list may exclude restricted-use pesticide sellers**, so Stripe has to confirm in writing before anything is built, and another processor may be needed. The manual fallbacks below are a **time-limited contingency**, used only if Mason chooses one at the 2026-12-15 checkpoint. Each has an owner and an end date for returning to the integration.

| # | What must work | Today (evidence) | Closed by | Rank |
|---|---|---|---|---|
| 14.1 | **The accountant approves the accounting map**: how invoices, payments and allocations, credits, prepay, refunds, write-offs, discounts, fees, inventory costs, vendor bills and commissions reach the books, with the chart-of-accounts mapping and closed-period rules. Needed for the sync *and* for hand entry | **Not started.** | Goal 7 | MUST |
| 14.2 | **QuickBooks Desktop sync**: the accountant confirms our Desktop version stays supported; a connection is proven on a copy of our company file by 2026-11-15; there's an operating plan (which PC, schedule, bookkeeper, alert on a failed sync); a reconciled test month by 2026-12-15 | **Planned, not started.** The connector choice and test steps are in the Goal 7 groundwork plan. | Goal 7 | MUST, or 14.3 approved as the contingency |
| 14.3 | **QuickBooks contingency**: a transaction-level CRX report and written steps for entering invoices, payments with their allocations, credits, prepay and corrections by hand. Each one is marked when entered, so nothing goes in twice, and each customer is tied out daily, signed by the bookkeeper. Rehearsed on staging, with the daily workload measured | **Process and report not written.** | Phase D prep | MUST if chosen |
| 14.4 | **Online card and ACH payments through Stripe**, with an invoice marked paid only on a verified Stripe settlement | **Not started.** Stripe may not accept us (see above); its written answer comes first. | Goal 7 | CAN-WAIT if 14.5 is approved |
| 14.5 | **Payment contingency**: written steps for checks and bank transfers. When a payment counts as received, who records it in CRX and QuickBooks, unapplied money, returned or bounced payments, and matching each day's deposit | **Process not written.** Recording payments by hand already works in CRX (6.1). | Phase D prep | MUST |

## 15. Business readiness (Mason's own tasks, no code)

These are Mason's checklists (goals doc, L1–L3), not agent gates. The full checklists are in the goals doc; these rows are the headline.

| # | What must be ready | Today (evidence) | Rank |
|---|---|---|---|
| 15.1 | **Opening balances, record by record** (L3): every customer balance, unpaid invoice, prepay or deposit, unapplied payment, outstanding credit, open order, unbilled delivery and stock balance matches Chem Man, QuickBooks and the count. Original IDs and the source system are kept, nothing is entered twice, and the bookkeeper signs | Not started. | MUST |
| 15.2 | **Inventory readiness** (L2): a stock count by product, package and location, approved adjustments, and old deliveries, reservations and receipts that still hold stock cleared. Receiving, partial delivery, return, void, transfer and field use all checked | Not started. On 2026-08-19 there were 19 negative stock rows, and five products still flag in the integrity report until counted (`KNOWN_ISSUES.md`, 2026-10-07 entry). | MUST |
| 15.3 | **Compliance readiness** (L1): EPA numbers and labels verified; customer and staff licenses on file; expired, missing and wrong-state licenses and label restrictions handled; a full reporting period produces correct state reports. Mason decides wherever a rule needs a hard block instead of today's warning | Not started. Today the RUP license check only warns (`src/lib/rupCompliance.ts`). | MUST |

## 16. Launch readiness: trial, developer, cut-over and pilot operations

| # | What must be ready | Today (evidence) | Closed by | Rank |
|---|---|---|---|---|
| 16.1 | **The November–December trial**: a few chosen customers billed through CRX, quote to payment, each sale billed in one system only, with a log, reconciliation and a written result | **Not started** (goals doc section 2, Mason 2026-10-15). | Mason + agents | MUST |
| 16.2 | **The senior developer**: engaged for early design reviews (QuickBooks, split billing, recovery), the December independent review, their must-fix list fixed and rechecked, written sign-off, and agreed launch support with a backup contact | **Not engaged yet** (goals doc, open question 6d). | Goal 10 | MUST |
| 16.3 | **Cut-over checklist**, timed and rehearsed on staging: Chem Man's last bill, final extracts and record counts, opening entries, a check for work entered during the handover, CRX's first bill, and a go/no-go record | **Not written.** | Mason (L3) + agents | MUST |
| 16.4 | **What history moves into CRX** and what stays read-only in Chem Man, and that Chem Man history can still be opened after billing stops | **Not decided** (goals doc, L3). | Mason (L3) | MUST |
| 16.5 | **Daily pilot check** for the 30 days: balances, payments, credits, stock and QuickBooks (synced or hand-entered), with an owner and a backup. Every unexplained difference is logged, found and fixed, and reviewed by Mason and the bookkeeper | **Not written.** The integrity checks exist (PR #988) but there's no one-page daily check. | Phase D prep | MUST |
| 16.6 | **Emergency brake**: who can pause one affected operation, numbered paper records for it, entering and reconciling them afterwards, and who releases the pause. Everything else stays in CRX | **Not written or rehearsed** (goals doc, Phase D). | Phase D prep | MUST |
| 16.7 | **Outage paper fallback** for dispatch, delivery and payments, printed and rehearsed | **Not done** (goals doc, Goal 6). | Goal 6 | MUST |
| 16.8 | **Launch support**: where staff report a problem (app error, failed email, stuck bill, sync failure, stock difference), who answers, how fast, and when to pull the emergency brake | **Not written.** | Phase D prep | MUST |
| 16.9 | **Training per role in December**, on staging, covering normal work *and* the exceptions: partial delivery, return, split billing, failed payment, missing signature, outage | **December** (goals doc, Phase D). | Phase D | MUST |

## 17. Can wait until after the pilot

| Item | Why it can wait |
|---|---|
| Field-application split billing (4.5) | Parked by Mason, 2026-10-15. |
| Blend-ticket billing that picks the exact quoted line by itself | Parked by Mason; staff pick it today (5.2). |
| Multi-tier blend linkage (5.6) | No money effect today. |
| Season stamps and reads (12.3) | Only wrong around October 1. |
| Online payments (14.4) | Only if Mason approves the payment contingency (14.5). |
| Full offline proof of delivery, grower portal, an expired "uncertain request" locking its dialog | Dropped or parked by Mason; the last is rare and low risk (`KNOWN_ISSUES.md`, 2026-09-11). |

---

## What Mason needs to decide

Recommended answers first. Reply with the number and "yes", or say what to change.

1. **Approve the ranking rule and the MUST list** (the "How each item is ranked" section and every row marked MUST). Recommend: approve them now, so the next ten weeks work from one list. The QuickBooks and payment contingencies (items 3 and 4) are a separate yes, after they're written and rehearsed.
2. **Senior developer (open question 6d).** Who, the cost, whether they can start in October for early reviews, the December review, and launch support. Recommend choosing them by 2026-10-31, the checkpoint already in the goals doc.
3. **QuickBooks at the 2026-12-15 checkpoint.** If the sync isn't proven, do we start January 1 on the hand-entry contingency (14.3), or move the date? Recommend: start on hand entry **only if** it has been rehearsed on staging and the bookkeeper confirms they have the time, with a written date for returning to the sync. Otherwise, move the date.
4. **Online payments.** If Stripe isn't approved and tested by 2026-12-15, start January 1 with checks and bank transfers under the written payment steps (14.5)? Recommend **yes**. Customers pay that way today, and Stripe can follow during the pilot.
5. **Name an owner and a backup** for: the daily pilot check (16.5), hand entry into QuickBooks if used, the emergency brake (16.6), launch support (16.8) and recovery (13.5). Recommend naming them by 2026-12-01, so they rehearse in December.
6. **Who reviews printed and emailed documents (9.2) and approves the money reports (10.2)**, and by when. Recommend the bookkeeper, by 2026-12-01.

**Actions already decided, still waiting on Mason** (not new decisions):
- **Upgrade Supabase to Pro and turn on point-in-time recovery** (decided 2026-10-13). Due this week, because the rewind-to-a-time drill (13.2) can't run without it. The first database-only restore of the existing weekly dump doesn't wait on it and can run now (`docs/plans/2026-10-18-goal-6-safety-net-findings.md`).
- **Add the two storage-key secrets** that the file backup (13.3) waits on.
- **Send Stripe the eligibility question** about restricted-use pesticide sales (section 14, and section 5.6 of the Goal 7 groundwork plan).
- **Fallback for December 31 evening**: if the quote and order number fix (12.1) misses its December proof, staff stop entering quotes and orders in CRX after 6 pm that evening. It's a backup plan, not a substitute for the fix.

---

## Sol review findings not applied, and why

Checked against the goals doc and the code on 2026-10-21.
- **"No money effect" on multi-tier blend linkage (Sol finding 46, which Sol rated low-confidence).** Kept. `KNOWN_ISSUES.md` shows the recorded quantity is read by nothing, and it's a different issue from the duplicate-line pricing that PR #982 fixed.
- **Copying every goal's full acceptance list into each row (Sol findings 19–23, 30–34, 38).** Applied as one rule instead ("What 'done' means for each row"), with the key money words added where a row was misleading (frozen money basis in 4.3, cumulative credit cap in 5.4, every void status in 3.5). Repeating the goals doc in full would make this list too long to approve.
- **The paper-ticket database check as a MUST (Sol finding 16).** Only the real-phone test is ranked MUST. The app already requires the photo on that path, which meets the goals doc's done test. A database-level check is extra protection, so it's SHOULD.

Sol finding 41 (the workload test and the rest of Goal 4 as MUST) was first kept as SHOULD. It was applied after the Codex GitHub review on this PR made the same point: Goal 4's done test is a launch gate (rows 6.6, 10.3 and 10.4 are now MUST).

## Sources

- `docs/plans/2026-10-13-direction-and-goals.md` (sections 2, 3, 4, 5 and 6).
- `docs/manual/CURRENT_STATE.md` (migration ledger read 2026-10-21; shipped feature map; environment facts).
- `docs/manual/KNOWN_ISSUES.md`, the OPEN entries named in each row.
- `docs/plans/2026-10-18-goal-6-safety-net-findings.md` and the two 2026-10-19 Goal 6 drafts.
- `src/utils/season.ts` (the season boundary is October 1).
- `docs/plans/2026-10-21-goal7-quickbooks-stripe-groundwork.md` and `docs/operations/production-runbook.md` (storage backup and backup alerting rows).
- `git log` on `origin/main` through `d720cf681` and the open PR list, both read 2026-10-22.
- Advisory Codex `gpt-6-sol` (high) review of the first draft, 2026-10-21 (57 findings).
