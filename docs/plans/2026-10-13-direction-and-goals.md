# CRX Manager: Direction and Goals (October 2026)

**Owner:** Mason Wells. **Drafted:** 2026-10-13, from the scalability review (Claude, plus two independent Codex Sol reviews). Mason's decisions were recorded the same day.
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
| **A. Build** | Finish Goals 1–7 below, including the QuickBooks and payment integrations, while tracking Goal 8. | Goals 1–7 each pass their "done" test live. Goal 8 is an ongoing target, not a gate. |
| **B. Clean up** | Goal 9: docs, files, branches, open issues and the AI tooling all tidied and explained. | A newcomer can find, run and understand everything. |
| **C. Hand off** | Goal 10: an outside **senior software developer** gets the handoff pack, sets the system up, and reviews it independently. | The developer signs off, or their must-fix list is done. |
| **D. Roll out** | The whole business runs on CRX, and Chem Man is retired for billing. | Spring 2027 season billed entirely in CRX. |

**Timeline risk:** spring 2027 is about 5 months away. Added together, the build estimates come to roughly 4–7 months of agent work if done one after another, so goals must run in parallel sessions where they don't touch the same code. If Phase A slips past January, either the rollout date or the scope has to give. Mason decides which, when it happens.

## 3. Where we are today (2026-10-13)

**Already strong. Keep it.**
- The money and inventory rules are enforced inside the database itself, not just on screen. Double-clicks and dropped connections can't create duplicate invoices or wrong stock.
- Every table has access rules, and there are four roles: admin, sales rep, driver and applicator.
- Size isn't a constraint. The database is under 100 MB; ten times the business is still small.
- Field features exist: offline mode, lot tracking, EPA/RUP (restricted-use pesticide) compliance, PDFs and email.

**The real bottleneck is usage, not features.** The app holds about 13 invoices, 65 orders and 4 quotes in total, and spring 2026 was billed in Chem Man. The July roadmap made the same observation (8 invoices then). In three months the app's tooling grew a lot, but the business running through it barely did.

**Gaps:**
1. **Security.** Any logged-in user can pull the restricted-use sales register (confirmed live). Photos are viewable by link. Field staff can read cost data.
2. **Billing correctness.** Posting with unsaved edits uses the old amounts. A voided delivery leaves its posted invoice collectible. Some invoice types have no quantity caps. Blend-ticket pricing can pick the wrong price.
3. **Incomplete data at volume.** Reports, some integrity checks, pickers and list pages stop at 500–2,000 rows.
4. **Weak safety net.** The free hosting plan means backups are weekly only and there's no rewind. A test restore has never been done. There's no staging copy, and the browser tests are switched off.
5. **Offline proof of delivery.** A delivery completed without signal saves no signature image.
6. **Not yet the system of record.** There's no link to QuickBooks and no online payments.
7. **Process cost.** The AI tooling is nearly as large as the app.

## 4. Decisions made (do not reopen)

| Date | Decision |
|---|---|
| 2026-10-13 | **Sales reps may create, post and email invoices for ANY customer.** This reverses the 2026-10-09 admin-only plan; PR #902 was closed unmerged and never applied. |
| 2026-10-13 | **Reps invoice under their own name only.** A rep can't name another salesperson on an invoice; admins can reassign who gets credit. (5e) |
| 2026-10-13 | **Upgrade Supabase to the Pro plan with point-in-time recovery** before next season. It's a billing change, so Mason does it. (5a) |
| 2026-10-13 | **Photos become private:** delivery, receiving and team-note photos need a sign-in to view. (5d) |
| 2026-10-13 | **Chem Man stops being used for billing by spring 2027.** (5g) |
| 2026-10-13 | **Everything is built before handoff, integrations included.** Accounting sync and online card/ACH payments are part of Phase A. (This answers 5c: yes, online payments.) |
| 2026-10-13 | **The books stay in QuickBooks Desktop** (most company data is there today). CRX syncs to it. |
| 2026-10-13 | **All AI tooling is kept at handoff** and documented for the developer (Goal 9). |
| 2026-10-13 | The scalability review's verdict: **strong foundation, no rewrite; not yet ready for $10M.** |

## 5. Goals, in order

Each goal has a plain test for "done". That test is the **minimum**: each goal's own pull request turns it into exact test cases, covering every role, path and failure case it touches, and those are reviewed with the code. Sizes are rough agent-build estimates, not promises. Goals that touch different code can run at the same time.

### Phase A: Build

#### Goal 1: Close the security holes (about 1–2 weeks)
- Only admins can pull the restricted-use register.
- Photos require sign-in (decided, 5d).
- Drivers and applicators can't read product cost or margin; applicators only see fields for their assigned jobs.

**Done when:** separate live checks, one per rule and role, all pass:
- an admin can pull the register, and a sales rep, driver and applicator are each refused;
- for each of the three photo buckets (`delivery-photos`, `receiving-photos`, `team-note-attachments`), a signed-out visitor and a deactivated staff account are each refused a link, and an active signed-in staff member can still open it;
- a driver and an applicator are each refused cost and margin data;
- an applicator sees fields for their assigned jobs and is refused other fields.

#### Goal 2: Reps invoice any customer, under their own name (days). IN PROGRESS 2026-10-13, "Invoice work continuation" session
- Remove the "must be your own customer" check from saving and posting manual invoices and invoice groups.
- Stop reps naming another salesperson.
- Let reps find any customer when invoicing. Today a rep can only see customers assigned to them (the `customers_select` access rule, confirmed live 2026-10-13). How far reps' access to customer records widens is decided with Mason and built in the Goal 2 change. That change records the decision in its own PR and `DECISION_LOG.md` entry.
- Let reps email that invoice too. Today the invoice page finds the recipient through the same rep-filtered customer list.

**Done when:** a rep account, live, does all of the following for two customers, one with no assigned rep and one assigned to a different rep:
- finds the customer when invoicing;
- saves, posts and emails both a single invoice and an invoice group (split invoice) to them;
- is refused when naming someone else as salesperson.

#### Goal 3: Billing you can trust (about 2–4 weeks)
- Post uses what's on screen, or refuses until it's saved. The database enforces this, not just the screen: `post_invoice` and `post_invoice_group` check the invoice version the screen loaded and refuse if it changed. That way a save from a second tab or another user can't be posted unseen (see `KNOWN_ISSUES.md`).
- Voiding a delivery must leave nothing collectible for the goods on **that delivery**. A credit for exactly the voided delivery's value is issued automatically, or the void is refused until an admin issues it. Charges for the order's other deliveries stay collectible. A warning message alone (today's behavior) does not count.
- Cap whole-order invoices at what was ordered or delivered.
- Orderless invoices (made from scratch, no order or delivery) follow the rule Mason picks in question 6e.
- Blend-ticket pricing picks the right quoted price.
- Returns against a Chem Man-billed delivery **stay allowed**, with the credit handled in Chem Man or the books (Mason, 2026-10-07; see `KNOWN_ISSUES.md`). Not changed here. The issue goes away at the Chem Man cut-over (Goal 7).

**Done when:** each case is run against a real database copy and refuses or corrects as described. That includes these cases:
- on an order with several deliveries, voiding one removes only that delivery's value from what is owed, and the rest stays collectible;
- an invoice saved in a second tab after the first screen loaded is refused at Post;
- an orderless invoice that breaks the 6e rule is refused.

#### Goal 4: Complete numbers at any volume (about 2–4 weeks)
- Money reports and the remaining integrity checks are computed in the database.
- Pickers become search boxes.
- List pages get real paging and search.

**Done when:** with test data past the old limits (for example 5,000 invoices):
- every money total matches a database sum to the exact cent;
- every record-based integrity check matches a direct database count;
- picker search finds records beyond the old limits;
- list paging and search reach every record.

#### Goal 5: Proof of delivery works offline (about 1 week)
- Signature, photos and receipt sync when the device reconnects.

**Done when:** a delivery completed in airplane mode shows its signature, photos and receipt after reconnecting.

#### Goal 6: A real safety net (about 2–3 weeks, plus Mason's billing click)
- Supabase Pro plus point-in-time recovery (decided, 5a).
- A test restore every quarter, timed and logged. The first is overdue.
- Photos and uploads included in the backup.
- A staging copy of the system, with the browser tests back on in CI. The developer will need this too.

**Done when:** a restore drill succeeds and is logged, and CI runs the browser tests against staging. The drill must restore the database and also files from each protected upload bucket, and the restored photos and uploads must open. Today's backup copies database tables only, not stored files. A live check also confirms the project is on the Pro plan with point-in-time recovery on. One rewind-to-a-time recovery must be practiced on a throwaway copy.

#### Goal 7: CRX becomes the system of record (about 6–10 weeks)
- **QuickBooks Desktop sync.** Invoices, payments and credits flow from CRX into QuickBooks Desktop, and each night's totals reconcile.
  - Desktop has no simple cloud connection. The usual routes are Intuit's Web Connector (a small program on the QuickBooks PC), import files, or a paid connector service.
  - Start with the simplest route that reconciles, likely import files, and upgrade later. See open question 6a.
- **Online card and ACH payments.** A payment is marked received only when the processor confirms the money arrived.
- **Chem Man retirement plan.** Decide what history moves into CRX, what stays read-only, and the cut-over date.

**Done when:**
- a full test month of invoices, payments **and credits** lands in QuickBooks Desktop matching CRX to the cent;
- a real **card** payment and a real **ACH** payment each settle end to end;
- a pending payment and a failed or declined one each leave the invoice unpaid, with its balance unchanged, until the processor confirms settlement;
- a settled payment later reversed (an ACH return or a card chargeback) reopens the invoice balance exactly once, and the reversal reaches QuickBooks;
- the cut-over plan is written.

#### Goal 8: Spend on product, not process (ongoing; reviewed monthly through handoff, not a Phase A gate)
- Keep the freeze on new safety guards.
- Track product changes merged vs. tooling changes merged each month. **Target: at least 3 to 1.**

### Phase B: Clean up

#### Goal 9: Everything tidy and explained (about 2–3 weeks)
- **Docs.**
  - Cut `docs/` (about 1,000 files) down to a current set. Archive history instead of deleting it.
  - `KNOWN_ISSUES.md` (about 5,800 lines) becomes a short list of what's actually open; the history moves to an archive.
  - Mark stale plans as superseded.
- **Files and repo.**
  - Remove stray temp folders and unused scripts.
  - Settle every parked migration: apply it or close it.
  - Clear finished branches and worktrees. A branch-cleanup session is already working on this.
- **Open issues.** Every remaining known issue is fixed, or written down as an accepted risk with a reason.
- **AI tooling guide** (kept, per decision). One plain document covering:
  - what each hook, gate and script does;
  - how a human developer works alongside it;
  - how to switch each piece off safely if they choose.

**Done when** all of these hold:
- a newcomer can go from a clean checkout to a running app and passing tests by following the docs alone;
- no migration is parked;
- every open known issue is either fixed or marked as an accepted risk with a reason;
- no finished branches or worktrees remain;
- every stale plan is marked superseded;
- the AI tooling guide exists.

### Phase C: Hand off

#### Goal 10: Senior developer handoff and review (about 2–4 weeks with the developer)
- **Handoff pack:**
  - setup guide (under one hour to a running local copy);
  - architecture and data model;
  - business rules (quote to cash, inventory, commissions, compliance);
  - operations runbook;
  - decisions log;
  - open issues;
  - AI tooling guide.
- **Access:** GitHub, Supabase, Vercel, Sentry, the email service, Google Vision, Mapbox and payment-processor accounts. Mason grants each one; the developer gets their own login, never a shared password.
- **The developer's independent review** of security, money paths and operations before rollout. Its must-fix items go in front of Phase D.

**Done when:** the developer has run the system on staging, finished their review, and signed off. Phase D starts then.

### Phase D: Roll out
- Train staff, cut over from Chem Man, and bill the spring 2027 season entirely in CRX.

## 6. Open questions

| # | Question | Recommendation |
|---|---|---|
| 6a | Stay on QuickBooks Desktop long-term, or move to QuickBooks Online? Intuit has been steering new customers to Online, so ask your accountant whether your Desktop version will stay supported. Online is much easier to connect to. | Ask the accountant now; the developer weighs in at handoff. Goal 7 builds for Desktop unless you decide to move. |
| 6b | When stock runs short, should a delivery warn (today) or be blocked? | Keep warn-only until physical counts are clean, then decide. |
| 6c | Which card/ACH processor? | Pick one that matches your bank and offers capped ACH fees. Decide during Goal 7. |
| 6d | Who is the senior developer, and when do they start? | Line them up by January so Phase C isn't waiting. |
| 6e | Should an invoice made from scratch (no order, no delivery) be allowed to carry product lines at all? There's nothing to cap its quantity against. | **No.** Products are billed through an order or a delivery; from-scratch invoices carry only service or misc charges. Decide before Goal 3 starts. |

## 7. Not doing (parked on purpose)

- Admin-only invoicing (PR #902, closed 2026-10-13).
- Limiting reps to their own customers.
- New safety guards during the freeze, unless a real incident calls for one.
- A grower portal (customers logging in themselves) comes after rollout.

## 8. Source evidence

- Claude scalability review plus two Codex `gpt-6-sol` reviews (adversarial and independent), 2026-10-13. Each top finding was checked against live database definitions. One Sol claim, that voiding a delivery cancels other deliveries' drafts, was refuted: it's already fixed live.
- `docs/manual/KNOWN_ISSUES.md` holds the full open-issue list; this doc covers only what moves the $10M goal.
