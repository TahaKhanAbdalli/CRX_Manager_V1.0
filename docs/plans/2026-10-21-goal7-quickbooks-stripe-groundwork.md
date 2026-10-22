# Goal 7 groundwork: QuickBooks Desktop sync, accounting map, Stripe plan

**Date:** 2026-10-21. **Status:** research and plan only. No app code or database changes. Nothing has been signed up for, and no one has been contacted.
**Parent plan:** `docs/plans/2026-10-13-direction-and-goals.md`, Goal 7 and the section 2 checkpoints. The QuickBooks connection must be proven by **2026-11-15**, and Goal 7 must be done by **2026-12-15**.
**Review:** Codex `gpt-6-sol` (high) reviewed an earlier draft as an advisor. It returned 52 findings. Each one was checked against sources and the code before it changed this plan. Most are now built into the sections below. Three more review rounds by a second AI reviewer then tightened this document. Two of their points were checked and rejected; everything else was fixed. Finer edge cases left after the third round go to the senior developer's design review (section 7), not to more rounds here.

---

## 1. The short version (read this first)

1. **QuickBooks connection: test Conductor first.** It's a paid service ($49 a month per company file) that talks to QuickBooks Desktop through Intuit's own Web Connector. Its documented features include applying a payment to exact invoices and applying credits. Use it for the 11-15 test on a **copy** of the company file. Choose it for real use only if it passes the scored test in section 3.4. If it fails, the fallback is a Web Connector service of our own, built by the senior developer.
2. **Stripe may not accept us. Ask in writing before anything is built.** Stripe's prohibited-business list includes "Pesticides requiring application by a certified professional", which is what restricted-use pesticides are. It also includes "Toxic, flammable, combustible, or radioactive materials" ([Stripe restricted businesses](https://stripe.com/legal/restricted-businesses), updated 2026-09-22). This is the biggest unknown in Goal 7. Mason should get Stripe's answer in writing. In parallel, the developer should shortlist a backup processor that, in writing:
- accepts restricted-use pesticide sales;
- offers a hosted card and ACH page;
- sends signed webhooks;
- handles ACH returns, disputes and refunds;
- provides payout reconciliation data.

Section 5 then carries over with that processor's event names.
3. **The accountant must make five choices before coding.** Prepay, write-offs, inventory value, who owns vendor bills, and how commissions are booked (section 4.3). The rest of the map can be decided by the developer with the accountant's sign-off.
4. **One concrete fix found.** QuickBooks Desktop invoice numbers can be at most 11 characters ([Conductor invoice create](https://docs.conductor.is/api-ref/qbd/invoices/create)). CRX numbers like `CS-2026-0001` are 12. The sync will drop the dashes (`CS20260001`, 10 characters; field-application `INV20260001`, 11) and keep the full CRX number in the invoice memo. A field-application invoice numbered 10,000 or higher in one year would still be too long, so the sync refuses it and flags it rather than cutting it short.
5. **What Mason does next:** answer the questions in section 3.5 this week, and send Stripe the eligibility question in section 5.6.

---

## 2. Words used here

- **QuickBooks Desktop (QBD):** the accounting program installed on a Windows PC. The books stay here (decided 2026-10-13).
- **Company file:** the single QuickBooks data file (`.QBW`) that holds the books.
- **Web Connector:** a small free Intuit program on the QuickBooks PC. Every few minutes it asks a web service, "any work for QuickBooks?" It's the standard way a cloud app reaches QBD.
- **Connector:** a paid company that runs that web service for us and gives CRX a simple interface. Conductor is one.
- **TxnID / ListID:** QuickBooks' own permanent ID for a transaction (TxnID) or for a customer or item (ListID).
- **Webhook:** a message Stripe sends to CRX's server saying something happened, such as "this payment succeeded".
- **Settled:** in this plan, the moment CRX treats a payment as real money and lowers the invoice balance (section 5.2).

---

## 3. QuickBooks Desktop sync

### 3.1 What we compared and how

Every option was scored on:
- **(a)** payments applied to the exact invoices;
- **(b)** credits created and applied;
- **(c)** recovery from failures without duplicates;
- **(d)** a permanent link from each CRX record to its QuickBooks record;
- **(e)** cost;
- **(f)** what Windows and hosting it needs.

| Option | (a) Exact invoices | (b) Credits | (c) Recovery | (d) Permanent link | (e) Cost | (f) Windows needs |
|---|---|---|---|---|---|---|
| **Conductor** (hosted API over Web Connector) | Yes. A payment lists each invoice and amount (`applyToTransactions`), and auto-apply is off by default ([docs](https://docs.conductor.is/api-ref/qbd/receive-payments/create)) | Yes. Credits are applied inside a payment (`applyCredits`); credit memos can be created and voided ([docs](https://docs.conductor.is/api-ref/qbd/credit-memos/create)) | Partial. Writes have no built-in duplicate protection. We can tag each record with our own ID (`externalId`, a GUID set at creation), but **the list can't be searched by that tag** ([list docs](https://docs.conductor.is/api-ref/qbd/receive-payments/list)). Default wait is about 90 seconds; it fails fast if QuickBooks is offline ([timeouts](https://docs.conductor.is/api-ref/timeouts)) | Returns QuickBooks' ID and a revision number for edits | $49/month per company file in use; sample files are free ([FAQ](https://docs.conductor.is/faq)) | Web Connector on an always-on, signed-in Windows PC; QuickBooks open is recommended ([FAQ](https://docs.conductor.is/faq)) |
| **Our own Web Connector service** (qbXML over SOAP) | Yes. `ReceivePaymentAdd` takes one `AppliedToTxnAdd` per invoice | Yes. Credits are applied inside `ReceivePaymentAdd` | We build all of it. The SDK's error recovery may not be available through the Web Connector (unverified) | Yes, TxnID and EditSequence | No vendor fee, but more developer time and upkeep | Same PC needs. Our server must answer each step within about 2 minutes, and its fit with Vercel's short-lived functions is unverified ([Intuit QBWC guide](https://static.developer.intuit.com/resources/QBWC_proguide.pdf)) |
| **Desktop SDK directly** (a Windows program on the QuickBooks PC) | Yes | Yes | Has the SDK's own error recovery | Yes | Highest build and upkeep | We'd build and maintain our own Windows program. Not advised without an in-house developer |
| **Unified APIs** (Codat, Rutter, Merge, Apideck, Unified.to) | Varies; unconfirmed for most | Mostly unconfirmed | Merge documents duplicate-protection keys, but its writes run in the background and return a temporary ID first ([Merge](https://help.merge.dev/articles/10064812-building-to-quickbooks-desktop)) | Varies | Sales-call pricing for Codat, Rutter and Merge. Apideck about €599/month ([pricing](https://www.apideck.com/pricing.md)). Unified.to from $750/month ([pricing](https://unified.to/pricing)) | All use Web Connector. Codat supports only the latest three versions ([Codat](https://docs.codat.io/integrations/accounting/quickbooksdesktop/software-and-hardware-requirements)). Apideck's QuickBooks Desktop support is beta |
| **Manual import tools** (Transaction Pro, SaasAnt) and **IIF files** | IIF: **no** | – | A person runs each import | No IDs come back | Low | Desktop install |

**IIF stays a fallback only.** Intuit says an IIF import "doesn't link transactions" and that you have to link an invoice and its payment by hand afterwards ([Intuit IIF article](https://quickbooks.intuit.com/learn-support/en-us/help-articles/export-or-import-intuit-interchange-format-iif-files/00/262337)).

Also ruled out:
- **Railz and Agave:** no confirmed QuickBooks Desktop writes.
- **CData Gateway:** needs an inbound connection into the QuickBooks PC, which is a security downside.

### 3.2 Recommendation and why

**Test Conductor first. Decide only after the scored test (3.4), not on price.**
- It is the only connector focused on QuickBooks Desktop whose public documentation covers payments applied to exact invoices, applied credits, voided credit memos and a health check.
- It costs little, though the fee isn't the main cost. Rough first year:
  - Conductor: about $590 ($49 × 12) for the live file, plus the test copy unless it's exempted.
  - QuickBooks Desktop: the subscription we already pay.
  - The always-on PC: an existing office PC, or a small cloud Windows machine at an estimated $40–$100 a month. That figure is not a quote.
  - The developer's build and upkeep: the biggest cost, priced by the senior developer.

  Our own Web Connector service removes the Conductor fee but adds more developer time, both to build it and to maintain it.
- It lets us practise on free sample files before touching Mason's real file.
- A hired developer can review its plain JSON interface far more easily than a home-built SOAP service.

Before relying on it for live billing, also check:
- support response times;
- exporting our data;
- audit logs;
- how credentials are held;
- what happens in an outage;
- how we would leave.

If Conductor fails a must-pass case, the senior developer prices our own Web Connector service. The rules in 3.3 apply either way.

**Supported QuickBooks versions.**
- QuickBooks Desktop 2024 and Enterprise 24 were Intuit's **last annual versions**; updates now arrive continuously. Sources: [Intuit, French Canadian page](https://quickbooks.intuit.com/learn-support/fr-ca/help-article/update-products/comprendre-processus-lancement-quickbooks-desktop/L2tnnGnFE_CA_fr_CA), and a QuickBooks Team reply in the US community saying no 2025 or 2026 versions were released ([community](https://quickbooks.intuit.com/community/other-questions-9/quickbooks-desktop-2025-release-88075)). This isn't a formal US policy page, so the F2 screen plus Conductor's own support list (Enterprise any version; Pro, Premier and Accountant 2018 and later) decide whether our copy qualifies.
- All **2023** editions lost support after **2026-05-31** ([Intuit discontinuation policy](https://quickbooks.intuit.com/learn-support/en-us/help-article/feature-preferences/quickbooks-desktop-service-discontinuation-policy/L17cXxlie_US_en_US)).
- Intuit's page gives **no end date for 2024**. Third parties say either 2027-09-30 or "no end date", and neither is confirmed by Intuit.
- So we must be on 2024 (release R18 or later) or Enterprise 24. The accountant confirms the support date (decision 6a).
- New Pro Plus and Premier Plus subscriptions stopped on 2024-09-30, and Enterprise is the only Desktop product still sold to new customers ([Method](https://www.method.me/blog/quickbooks-desktop-discontinued/), not Intuit).

### 3.3 Rules the sync must follow (whichever connector)

This section is mainly for the developer. In plain terms: CRX keeps a to-do list of everything that must reach QuickBooks, sends each item once, checks that it arrived, and hands anything doubtful to a person instead of guessing. These rules answer Sol's recovery and payment findings. The developer designs the details; these rules are fixed.

1. **A sync queue in the database ("outbox").** Every accounting event gets its own row when it happens in CRX. Examples: invoice posted, payment recorded, credit applied, payment voided, write-off. The row gets its permanent tag (a GUID) **before** the first send. Rows are unique per event, so a repeated event can't create a second row.
2. **One sender at a time.** A worker claims a row with a time-limited lock. Only one worker writes for a given customer at a time. Steps run in order: customer and item first, then invoice, then payment or credit, then any application.
3. **"Done" means read back.** A row is confirmed only after CRX reads the record back from QuickBooks and checks the customer, amount, date and every invoice application.
4. **A lost reply is never blindly re-sent.** If a write times out, CRX searches that customer's QuickBooks records around that date and matches on our tag, because Conductor can't search by tag directly. A reference number alone is never treated as proof, since users can edit it and it needn't be unique.
   - If the record is found, link it.
   - If CRX can't tell whether it landed, the row goes to **needs review** with a named owner. It is never sent again automatically.
5. **Links at the right level.** CRX stores QuickBooks' ID, and its revision, for every record it writes, and for **each payment-to-invoice and credit-to-invoice application**. When a replacement record is made, the link history shows which record replaced which.
6. **Half-finished work resumes, it doesn't replay.** Each step is confirmed on its own. If the invoice landed but the payment failed, only the payment is retried.
7. **Edits and deletions made in QuickBooks are noticed, and every night both sides are checked in full.**
   - A regular check of recently changed QuickBooks records (Conductor's `updatedAfter` filter) compares them with CRX.
   - Conductor's deleted-transactions feed shows records deleted by hand. It only reaches back 90 days, so it is read at least daily ([docs](https://docs.conductor.is/api-ref/qbd/deleted-transactions/list)).
   - Each night a full comparison runs both ways: transaction counts, invoice numbers, each customer's open balance, payment and credit applications, and the mapped accounts. That way a missing outbox item, or a linked record that quietly disappeared, is caught.
   - Any difference goes to a person, and CRX never overwrites it.
8. **After a restore of either side, stop.** Writes pause. Both sides are compared using the stored company-file identity and the last confirmed point. Links are rebuilt only from records verified in QuickBooks before syncing resumes. This matches Goal 6's "reconcile before syncing resumes" rule.
9. **Never auto-apply a payment.** Every payment names its invoices and amounts.
10. **Corrections keep the history.** Each kind of correction gets its own written procedure: invoice cancellation, payment reversal, credit reversal, ACH return, refund. In a closed month, the correction is a new entry dated in the open month and linked to the original. The original is never voided or edited. QuickBooks' closing date is set to match CRX's closed months.
11. **Stripe IDs are linked too.** CRX stores the Stripe IDs for each payment attempt (Checkout Session), payment (PaymentIntent and charge), refund, dispute and payout, plus the Stripe balance-transaction ID behind each charge, fee, refund and dispute (the record that ties it to a payout), each tied to its CRX record, so any Stripe event can be traced to the invoice and to the QuickBooks entry it produced.
12. **Some records flow back from QuickBooks.** Anything QuickBooks creates that CRX must know about, such as vendor bill payments if decision 4 puts them in QuickBooks, is read back on a schedule (Conductor's `updatedAfter` filter). It is matched to its CRX record by the linked ID, and anything that doesn't match exactly goes to a person.
13. **Health alerts.** A named person is alerted when nothing has synced for a set time, when rows are waiting in "needs review", or when the QuickBooks PC is offline. Nobody assumes last night worked (Goal 7 text).

### 3.4 The 11-15 connection test (steps for Mason)

**Mason's part (about 1–2 hours; no coding):**
1. In QuickBooks, press **F2** and write down the product name, year and release (for example "QuickBooks Desktop Premier Plus 2024, R18"). Send it with the answers in 3.5.
2. Make a **copy** of the company file. Use *File → Back Up Company*, then *File → Open or Restore Company* to restore it under a **new name** such as `CRX-SYNC-TEST.QBW`. Put it in a new folder on the PC that will run the sync, and **never** point the test at the live file. Then, with the copy open, rename the company inside it: *Company → My Company*, set the name to `CRX SYNC TEST`. Write down the copy's full folder path.
3. Install Intuit's free **QuickBooks Web Connector** on that PC, if it isn't already there.
4. Sign up for Conductor yourself (an agent never signs up or enters passwords). **Cost:** sample files are free, but a connection to a copy of a real company file is billed at $49 a month unless Conductor's support grants a free test exemption, which they offer for files used only for testing ([FAQ](https://docs.conductor.is/faq)). Ask for the exemption. Either way, this is your decision to pay. Follow its setup steps for a company file, and load the setup file it gives you into the Web Connector.
5. Open the **copy** in QuickBooks as Admin, in single-user mode. When asked to let the app in, choose "Yes, always allow access even if QuickBooks is not running", and pick a QuickBooks user made just for the sync. You can change this later under *Edit → Preferences → Integrated Applications* ([Intuit](https://quickbooks.intuit.com/learn-support/en-ca/help-article/multi-user-mode/fix-error-qbwc1039/L2WqXx5LW_CA_en_CA)).
6. Tell the senior developer it's connected. They do the rest. An AI agent may draft scripts for them, but it never connects anything, enters a password, or writes to any company file on its own. It never touches the live file at all.

**Developer part (first read-only, then test writes, all on the copy):**
1. **Check it's the copy.** Through the connector, read back the company name, and the file path if the connector exposes it; that path read-back is unconfirmed. Stop before any write unless the name is `CRX SYNC TEST`. If the path can't be read, Mason confirms on the PC that only the copy is open in QuickBooks and that the Web Connector entry points at it.
2. Create clearly marked test records: a customer "ZZ TEST Grower" and a non-taxable test item.
3. Run the must-pass cases below. Each one is checked by reading QuickBooks back, and every QuickBooks ID is recorded.
4. Save QuickBooks' *Open Invoices* and *Customer Balance Detail* reports before and after, as screenshots or PDFs.

| # | Must-pass case | Pass means |
|---|---|---|
| 1 | Invoices using the mapped numbers: a 10-character one (`CS20260001`) and an 11-character one (`INV20260001`); then a 12-character number | Number, customer, lines and total match. The 12-character one is refused by CRX before sending |
| 2 | Partial payment on one invoice | Exact amount applied; the right balance remains |
| 3 | One payment across two invoices | Each invoice gets exactly its share |
| 4 | Overpayment, with the rest applied to a later invoice (if the accountant picks prepay option A), including after the payment's month has closed | The leftover shows as customer credit and later applies exactly. If QuickBooks can apply it only by editing the original payment, the closed-month case fails, because rule 10 forbids editing a closed-month original and the closing date blocks it. That outcome counts against option A |
| 4b | Prepay as a Customer Deposits liability (if the accountant picks option B) | The deposit sits in the liability account, then moves to the invoice exactly when applied, and a partial application leaves the right remainder |
| 5 | Credit memo applied to an invoice | Credit used and invoice reduced. A second credit can be reversed without touching the first |
| 5b | Reversing a credit application after its month has closed | The original stays untouched, a linked reversal appears in the open month, and the invoice and the credit's remaining balance are both correct |
| 6 | Payment reversal | First record what QuickBooks allows for a payment (void, delete or edit; whether `TxnVoid` supports payments is unconfirmed). Delete and edit are ruled out for live use. The candidate reversal that keeps the original is a void if it is allowed, or else a new linked entry chosen with the accountant: for example a refund-style entry, or a journal that puts the amount back on the invoice. Perform the chosen entry in an open month and in a closed month. The original stays, the reversal is linked, and the invoice balance reopens by exactly the reversed amount (rule 10) |
| 7 | Forced lost reply (connection cut mid-write) | Recovery finds the record by tag and makes no duplicate |
| 8 | Edit made in QuickBooks by hand | CRX's check flags it |
| 9 | Write into a month before QuickBooks' closing date | Refused or flagged, never silently back-dated |
| 10 | Stripe-style entries (section 5.5): two payments into a "Stripe Clearing" account, a fee, a refund, then a payout transfer to the bank | Stripe Clearing ends at the right balance and the bank gets the net amount. Each Stripe event is booked once |

**Before the first live write (after the copy test passes):**
- Mason approves the live connection in the conversation.
- A fresh backup of the live file is made.
- The live company name and path are read back.
- The first sync is limited to a few marked records and reconciled.
- There is a written rollback: stop the queue and void or correct by procedure.

The **11-15 checkpoint** passes on cases 1, 2, 3 and 5 (invoice, applied payment, credit). Cases 4 or 4b and 6–10 must pass before Goal 7 is done (12-15). If a must-pass case fails, the senior developer prices our own Web Connector service, and Mason hears the effect on the date straight away.

### 3.5 Questions for Mason (answer before the test)

1. **Edition and year** (F2 screen): Pro, Premier or Enterprise? A "Plus" subscription? Which release?
2. **Which PC** holds the company file? Is it always on? Which Windows version? Is it a desktop in the office, a server, or a hosting service like Rightworks? Note that Rightworks stops background programs when you log off ([Conductor on Rightworks](https://docs.conductor.is/help/guides/rightworks)).
3. **Where the company file lives:** the folder path, whether it's on that PC or a network drive, and whether people use it in multi-user mode.
4. Who is the **bookkeeper** who will own the sync alerts, and who is the **accountant** who signs off the map?
5. Is **inventory tracking** turned on in QuickBooks? Are items set up as inventory parts?
6. Is QuickBooks' own **finance charge** feature on? Is there a **closing date** set?
7. How are **vendor bills** paid today: checks printed from QuickBooks, online banking, or something else?
8. How are **commissions** paid: payroll, or checks to reps as vendors?
9. Do customer names in QuickBooks match CRX's names? Do any growers also exist as vendors? QuickBooks shares one name list across customers, vendors and employees, so duplicate names fail.
10. Are customer **jobs**, **classes** or **sales reps** used in QuickBooks today?

---

## 4. Accounting map (draft for the accountant)

### 4.1 Ground rules

- **No sales tax** is charged on anything (Mason, 2026-10-15). CRX has no tax fields at all: a search of the schema registry and migrations found none. The plan is to set every sync customer and item non-taxable in QuickBooks, but **only after the accountant confirms in writing** that this is correct for every product, state and customer we sell to. Until then, the tax setting stays an open item and nothing goes live.
- **Nothing is entered in both systems.** Each item below has one creator.
- **What syncs:** only posted CRX records. Drafts and unposted invoices never sync.
- **Dates:** each record carries an explicit accounting date, taken as the Chicago calendar date of a defined moment:
  - invoices: the invoice date;
  - office payments: the payment date entered;
  - Stripe payments: when Stripe reports success (for ACH, the "succeeded" event, not the day the customer clicked Pay);
  - refunds: when Stripe reports the refund **succeeded** (an ACH refund can take up to 3 business days and can fail);
  - disputes: when Stripe creates the dispute;
  - payouts: the payout's arrival date.

  If that date falls in a closed month, the entry is dated in the first open month and linked to the original. Stripe and sync times are also stored in UTC, and month-end and year-end edges are tested.
- **Cents:** CRX invoices, payments, prepay, credits, write-offs and vendor bills are whole cents (`bigint`). Some older values are decimal dollars: product cost, PO unit cost and commissions. The sync converts exactly, and line totals are compared to the cent.
- **Links:** today **no CRX table has any QuickBooks or Stripe ID or sync-status field.** A search for quickbooks, qbd, qb_, stripe and sync_status across the schema registry, migrations and `src` found nothing. Goal 7 adds the outbox and link tables from 3.3.
- **Closed months:** CRX already has `accounting_periods` with close and reopen functions, and `check_period_open` blocks posting, payments, voids, write-offs, prepay and finance charges in closed months. QuickBooks' closing date is kept in step with it.

### 4.2 The map

"Creates" is where the record starts. "Corrects" is where a fix is made. "Reaches the other" is how it gets into QuickBooks.

| Item | CRX today (tables / functions) | Creates | Corrects | Reaches the other |
|---|---|---|---|---|
| **Invoices** | `invoices` and `invoice_items`. Types: `chemical_sale` (CS-), `misc_charge` (MC-), `field_application` (INV-), `credit_memo` (CM-), numbered by `next_invoice_number`. Created by `save_invoice` and the `create_invoice_from_*` functions; posted by `post_invoice` / `batch_post_invoices`. | CRX | CRX. `unpost_invoice` works only with no money applied and the month open. `void_invoice` is admin-only and refuses while payments are applied. | Posting queues a QuickBooks **Invoice** under the mapped number (10 or 11 characters; anything longer is refused and flagged), with the full CRX number in the memo. Each line uses a mapped QuickBooks item and income account. A void becomes a QuickBooks void in an open month, or a linked credit in a closed month. **Once synced, unposting is blocked**, so the record is corrected or credited instead. |
| **Credit memos** | `invoices` rows of type `credit_memo` (negative), made by `issue_return_credit` from `returns`. Applications are kept in `credit_memo_applications` (append-only, reversible) via `apply_credit_memo_to_invoice`, `reverse_credit_memo_application` and `unapply_credit_memo`. | CRX | CRX | QuickBooks **Credit Memo**. Each application becomes its own QuickBooks payment record that carries only the credit (`applyCredits`, no cash), so one can be reversed without touching others. Must pass test case 5. **Gap:** `reverse_credit_memo_application` refuses once the application's month is closed, because it calls `check_period_open` on the date the credit was applied (`20260711050000_credit_apply_reversal_and_lifecycle.sql`). Goal 7 needs a linked reversal that is dated in the open month and keeps the original. In QuickBooks it becomes a new linked entry, never an edit of the closed-month payment. Test case 5b covers it. |
| **Payments and allocations** | `allocation_sets` (type `payment`) plus `invoice_line_allocations`, created by `allocate_payment` (only posted or overdue invoices). `void_payment` is admin-only and blocked in closed months. Methods: check, ACH, cash, credit card, wire, other. The legacy `payments` table and its functions are retired. | CRX (staff entry, or a Stripe settlement) | CRX | QuickBooks **Receive Payment** naming each invoice and amount, never auto-applied. Checks and cash go to Undeposited Funds and are grouped into a QuickBooks deposit that matches the bank deposit slip. ACH and wire receipts that land in the bank on their own go straight to the bank account. The accountant confirms this split. Stripe payments: when they count as paid is in 5.2, and their entries are in 5.5. A reversal follows the procedure that test case 6 proves. |
| **Overpayments** | Any unallocated part of a payment becomes a `prepay_credits` row (`source_type='overpayment'`). | CRX | CRX | Follows the prepay choice below. Under option A it stays as the unused part of the same QuickBooks payment; under option B it moves to Customer Deposits. Either way it must match CRX's prepay balance per customer, and stays separate from credit memos. |
| **Prepay and deposits** | `prepay_credits` and `prepay_applications`, plus `customers.prepay_balance_cents`. Created by `create_prepay_check_splits`; applied by `apply_prepay_to_invoice` / `batch_apply_prepayments`; changed by `edit_prepay_credit` / `delete_prepay_credit`. There is no stand-alone "unapply". | CRX | CRX | **Accountant's choice (decision 1):** (A) an unapplied customer payment in receivables, applied later by updating that payment (test case 4); or (B) a Customer Deposits liability account, moved to receivables when applied. A is simpler, but only if a later application can be made as a new open-month entry rather than an edit of a closed-month payment (decision 1, test case 4). B shows prepaid money as owed to customers at year end. **Gap:** CRX can't undo a mistaken prepay application today except by voiding the invoice or payment. Goal 7 needs a linked reversal of one application, which works in a closed month by dating the reversal in the open month. |
| **Refunds** | **Not in CRX today.** There is no refund table or function. Goal 3 adds "a refund paid outside CRX is recorded in CRX". | Money leaves through a QuickBooks check or a Stripe refund. CRX records it. | Whichever system issued it | Check refunds: a QuickBooks check against the customer's credit, linked in CRX. Stripe refunds: booked once, from the Stripe Clearing account (5.5). A refund pays back customer **credit**, never an open invoice. So the CRX refund first turns the refunded part of the payment into customer credit (by a linked reversal of that application), then pays the credit out. In QuickBooks this is the matching credit-refund entry against the customer, linked to the original payment. The developer confirms the exact QuickBooks transaction in the test. **Stripe refunds stay switched off until the developer writes the full refund lifecycle:** who can start one and who approves it, the CRX record and its Stripe ID, its states (requested, pending, succeeded, failed, canceled), where **only the move to succeeded** changes the customer's balance or credit and queues the QuickBooks entry, as one server-side database step. Requested, pending, failed and canceled change no money, because a failed ACH refund puts the money back in the Stripe balance ([Stripe](https://docs.stripe.com/payments/ach-direct-debit#tracking-refunds)). The refund record also needs the `refund.updated` and `refund.failed` events, retries without paying twice, and what happens if a dispute arrives during the refund (5.4). |
| **Write-offs** | `write_offs` via `apply_write_off` and `reverse_write_off`, also kept on `invoices.write_off_cents`. The reason is free text. | CRX | CRX (reverse) | **Accountant's choice (decision 2):** one method only, either a credit memo to a "Bad debt" item applied to the invoice, or a discount line on a payment, with the bad-debt account named. The reversal procedure is written down. |
| **Finance charges** | `generate_finance_charges` creates `misc_charge` invoices (MC-) plus `finance_charges` rows, once per customer per month, using the customer's rate. Reversed by voiding the invoice. | CRX | CRX | A QuickBooks **Invoice** with a "Finance charge" item and income account. **QuickBooks' own finance-charge feature must be off**, or customers are charged twice. A waived charge is a void (open month) or a credit (closed month). |
| **Discounts** | `invoices.discount_earned_cents` is **display only** and doesn't change the balance. There are no line-discount fields; split billing uses negative lines. | CRX | CRX | The display-only field is never sent to QuickBooks, because CRX's balance doesn't include it and the two systems would disagree. An early-pay discount actually given must first be recorded in CRX as an entry that lowers the balance: today that is a write-off with a "discount" reason, or a dedicated discount entry if the accountant wants one. It then reaches QuickBooks the same way, to a named discount account. Negative split lines map to a discount item. |
| **Sales tax** | None exists. | – | – | Not used, **once the accountant confirms in writing** (4.1). Then every item and customer is set non-taxable. |
| **Processor fees** | None in CRX. | Stripe | Stripe | Never in CRX receivables. They are booked from the Stripe Clearing account to a "Merchant fees" expense account (5.5). |
| **Inventory cost** | `products.current_cost` (dollars), `product_cost_basis`, and PO costs. Cost is snapshotted per invoice line (`invoice_items.cost_cents`, `invoices.total_cost_cents`). Receiving does **not** change product cost, and there is no running inventory value. | CRX (quantities and cost snapshots) | CRX | **Accountant's choice (decision 3):** the book method. A monthly journal from CRX cost snapshots alone isn't a complete valuation, because purchases, returns and adjustments are also needed. One option: QuickBooks items set as non-inventory, with a monthly inventory and cost-of-goods journal from a CRX report that reconciles opening stock, purchases, sales and adjustments to closing stock. |
| **Vendor bills and payments** | `vendor_bills` (`create_vendor_bill`, `update_vendor_bill`, `void_vendor_bill`) and `vendor_payments` (`record_vendor_payment`, `void_vendor_payment`; one bill per payment). Purchase orders: `save_purchase_order`, `receive_po_items`. | **Accountant's choice (decision 4)** | Same system | Suggested: CRX creates bills, because it matches them to POs, and syncs them as QuickBooks **Bills**. Payments are made in QuickBooks, where checks are printed, and CRX reads them back as paid (rule 12 in 3.3), with a person resolving any payment that doesn't match a linked bill. CRX today records one payment per bill. So a QuickBooks check covering several bills is stored with its QuickBooks ID plus one application per bill; partial payments, vendor credits and voids are read back the same way. This needs a small CRX change, priced by the developer. That would replace CRX's `record_vendor_payment` for these bills. Partial payments, one check for several bills, vendor credits and voids must be covered. |
| **Commissions** | `commissions` and `commission_payments` / `commission_payment_items` (decimal dollars), created by `create_commission_payment`, `post_commission_payment` and `void_commission_payment`. Goal 3 adds paid-commission deductions. | CRX (calculation) | CRX | **Accountant's choice (decision 5):** expense accrual, a bill to the rep as a vendor, or payroll. CRX's paid status must reconcile with how QuickBooks paid it. |
| **Customers and items** | `customers` (CRX account number from 100001) and `products`. | CRX | CRX | Matched once to existing QuickBooks names by a person, then linked by ID. New ones are created from CRX. Names that clash with vendors or employees get a rule (for example a suffix). |
| **Opening balances (cutover)** | Mason's task L3. | CRX holds the open balances from 2027-01-01 (L3), so payments on old invoices are recorded in CRX like any other. | CRX | **Suggested:** each invoice and credit still open on 2027-01-01 already exists in QuickBooks. So it comes into CRX as an opening-balance record **linked to its existing QuickBooks record of the right type**, never sent to QuickBooks as a new one:
  - an open invoice links to the QuickBooks Invoice's ID;
  - an unused credit links to the QuickBooks Credit Memo's ID;
  - an unapplied payment or prepay links to the QuickBooks payment's ID, or to the deposit under prepay option B.

  Later payments and credit applications target those exact records. Customer receivables totals in both systems are reconciled before the first CRX billing run. The accountant confirms. |

### 4.3 Decisions only the accountant can make

1. Prepay treatment: (A) unapplied payment in receivables, or (B) a Customer Deposits liability. Option A is acceptable only if test case 4 shows a later application can be made as a new entry in the open month. If QuickBooks needs the original payment edited, option A breaks the closed-month rule whenever prepay is applied after its month closes, which is common for preseason prepay, so option B (or a QuickBooks credit memo bridge the accountant designs) is the fallback.
2. Write-off method and bad-debt account.
3. Inventory value method for the books.
4. Who owns vendor bills, and who owns vendor payments.
5. Commission classification for each kind of recipient.

Also needed:
- Approval of the **closed-month date rule** (4.1). A record whose date falls in a closed month is dated in the first open month and keeps its original date in the memo and the link.
- **Sign-off on the chart of accounts and item mapping**, with one worked example entry per row: receivables, income by invoice type, Undeposited Funds, Stripe Clearing, bank, merchant fees, bad debt, inventory and cost of goods, commissions, payables, Customer Deposits if chosen, and finance-charge income.
- Confirmation that there is no sales tax.
- Confirmation that our Desktop version stays supported (6a).

---

## 5. Stripe plan

### 5.1 Hosted page and "pay this invoice" link

- **Use Stripe Checkout**, Stripe's own hosted payment page, with card and US bank account (ACH) turned on. CRX never sees card or bank numbers ([Checkout and ACH](https://docs.stripe.com/payments/ach-direct-debit/accept-a-payment.md?payment-ui=checkout)).
  - Payment Links are made for many payers and editable amounts ([Payment Links](https://docs.stripe.com/payment-links)).
  - Stripe Invoicing would copy every invoice into Stripe and adds 0.4% per paid invoice ([pricing](https://stripe.com/pricing)).
- **How the link works.** The emailed invoice carries a CRX link with a long random code that is hard to guess and can be turned off. That link pays **that invoice only**, so it is not the grower portal: it shows no other invoices and no other customer data. When it's opened, CRX's server makes a Checkout Session for the amount the customer chooses: the full balance or a smaller amount. The planned split is recorded in CRX **first**, and the Session carries the CRX payment-attempt ID in `client_reference_id` and in the payment's metadata ([Sessions API](https://docs.stripe.com/api/checkout/sessions/create)).
- **Several invoices at once.** Staff can make a combined link for invoices they pick for one customer, for example on a statement. That link covers exactly those invoices, for their full balances, with the split recorded in CRX. If the customer wants to pay less, they use the single-invoice links, so CRX never has to guess how a smaller amount is split. Customers never see a list of their other invoices through a link.
- **Preventing double payment** (Sol finding):
  - CRX reserves the amount being paid against each invoice when the Session is made.
  - It allows only one open Session per invoice, and expires the old one before making another. Sessions also expire by themselves within 30 minutes to 24 hours ([expire](https://docs.stripe.com/api/checkout/sessions/expire)).
  - It refuses a new Session while an ACH payment is still pending.
  - **Releasing the reservation:** a reservation is released only once Stripe confirms the Session can no longer collect money: it has expired (CRX expires it and reads it back), Session creation failed, or an ACH payment failed. A declined card alone doesn't release it, because the customer can retry on the same page. If CRX's request to create a Session times out, CRX doesn't assume it failed. It retries with the same idempotency key, saved before the first try, to get the same Session back, and releases only after confirming no payable Session exists. Release and any new payment attempt for the same invoice take turns in the database, and anything unclear goes to staff review. When staff record a payment, void or credit the invoice, or change its amount, CRX first expires any open Session for it. If a payment still arrives, it becomes an exception (below).
  - Stripe's idempotency keys protect against retried calls only, not against two Sessions both being paid ([idempotency](https://docs.stripe.com/api/idempotent_requests)). The guard therefore lives in the database.
- **Bank verification.** Instant bank verification is the default and costs $1.50 each. Small test deposits are the fallback and take 1–2 business days.

### 5.2 Which event counts as "settled"

| Payment | Event | What CRX does |
|---|---|---|
| Card | `checkout.session.completed` with `payment_status = paid`. CRX re-reads the Session from Stripe. | **Settled.** Records the payment through a **new server-only database function** that writes the same payment ledger as `allocate_payment`, using the Stripe payment's ID as the duplicate key. It is needed because `allocate_payment` refuses any caller that isn't a signed-in admin or sales rep (`20260713060300_harden_allocate_payment_idempotency.sql`), and the webhook has no staff login. The new function is granted only to the server's own role, never to signed-in users, and it keeps the same PostgreSQL money rules. |
| ACH started | `checkout.session.completed` with `payment_status = unpaid` (payment processing) | Invoice shows **"payment pending"**. **Balance unchanged.** No QuickBooks entry. |
| ACH succeeded | `checkout.session.async_payment_succeeded`, usually about 4 business days later ([ACH docs](https://docs.stripe.com/payments/ach-direct-debit)) | **Settled.** Same as card. |
| ACH failed | `checkout.session.async_payment_failed` | Pending cleared. Nothing recorded. Invoice stays open. |

Source for the pattern: [Stripe fulfillment](https://docs.stripe.com/checkout/fulfillment.md?payment-ui=stripe-hosted).

"Settled" still isn't final. CRX keeps separate states for **succeeded**, **in a payout** (reconciled to the bank) and **reversed**, and customer-facing wording follows the state.

**Webhook safety:**
- Check Stripe's signature against the raw message ([webhooks](https://docs.stripe.com/webhooks)).
- Save the event and its "to do" work in one database step, then answer Stripe quickly. Stripe retries for up to 3 days.
- Ignore repeated deliveries by Stripe event ID. Track each payment, refund and dispute by its **own** Stripe object ID and state, so two different refunds or disputes on one payment are never mistaken for repeats.
- Never rely on event order; always re-read the object from Stripe.
- Confirm the payment belongs to our Stripe account and live/test mode, in US dollars, for the expected customer and payment attempt.
- **A daily check compares Stripe with CRX**, in case an event never arrives. It covers everything that moves money: payments, refunds, disputes, payouts, and the balance transactions behind them. A missed refund or dispute event would otherwise leave an invoice showing paid while Stripe has already taken the money back. It also re-reads every Checkout Session and pending payment that CRX still treats as open or processing. That way a missed "expired" or "ACH failed" event can't leave a reservation or a "payment pending" flag stuck forever and block new payment links.

**Overpayment, wrong amount or a paid invoice:** Goal 7's acceptance test requires an overpayment to become prepay, so it does.
- Any amount collected beyond what is still owed is recorded through the same overpayment rule `allocate_payment` uses, applied by the new server-only Stripe function above (→ a `prepay_credits` row with `source_type='overpayment'`). This includes a payment on an invoice that was already paid or voided.
- That prepay is also flagged as an **exception for staff** (Sol finding), so nobody is surprised by credit they didn't ask for.
- If the customer wants the money back instead, staff refund it from that prepay through the refund flow (4.2), following the accountant's written rule.
- An end-to-end test covers each case: overpaying, paying an already-paid invoice, and paying a voided invoice. The prepay balance must change exactly once, and the flag must appear.

### 5.3 ACH returns and card chargebacks

- **ACH reversal window.** An ACH debit can be disputed for up to **60 days** from a personal account, or **2 business days** from a business account, and those disputes can't be contested. A bank failure can also arrive **after** "succeeded"; Stripe turns it into a dispute and charges $4 ([ACH docs](https://docs.stripe.com/payments/ach-direct-debit)). Many growers may pay from personal farm accounts, so large ACH payments carry real 60-day risk.
- **Card chargebacks.** Cardholders usually have up to 120 days to dispute. We have 7–21 days to respond, and Stripe charges $15 per dispute ([disputes](https://docs.stripe.com/disputes/how-disputes-work)).
- **Events:** `charge.dispute.created`, `charge.dispute.closed` (won or lost), and the ACH failure-after-success dispute. Funds withdrawn and reinstated show in Stripe's balance records ([balance types](https://docs.stripe.com/reports/balance-transaction-types)). The developer writes an **event-by-event table** before coding, checked against Stripe's event reference. For each event it gives the reason, the deadline, and whether it can be contested. A late bank failure (reasons `insufficient_funds`, `incorrect_account_details`, `bank_cannot_process`), an ACH customer dispute (final, can't be contested), a late-return inquiry (`warning_needs_response`, needing proof of authorization) and a card chargeback all behave differently.
- **CRX's handling.** Each reversal creates its own record: money withdrawn, the fee, and the outcome.
  - The balance reopens by **the disputed amount only**. That is the full payment for ACH, which can't be partly disputed, and possibly part of a card payment.
  - The reopening happens once per dispute ID, even if events repeat or the payment was already refunded.
  - If the payment covered several invoices, the reopened amount is spread back across the original applications in a fixed order the accountant approves.
  - **Dispute won:** Stripe returns the money. CRX records a new payment linked to the dispute, and restores exactly the allocations that the dispute reopened, invoice by invoice. Any part whose invoice has been paid another way since is held as an exception. Whether Stripe also returns the dispute fee on a win depends on the case. The fee is booked back only when Stripe's balance records show it returned.
  - **Dispute lost:** the reopening stands and the fee stays an expense.
  - In QuickBooks, each step is booked once through Stripe Clearing (5.5).
- **A gap in CRX today.** `void_payment` is admin-only and refuses in a closed month, so it can't serve as the reversal path. Goal 7 needs a separate **payment reversal** operation in PostgreSQL. It reopens the balance in the current open month and is linked to the original payment.

### 5.4 Refunds

- ACH refunds are **full only**, can be made within 180 days, and can't be cancelled. Card refunds can be partial ([ACH docs](https://docs.stripe.com/payments/ach-direct-debit)).
- Stripe warns that a refund plus a bank dispute can pay the customer back twice ([ACH docs](https://docs.stripe.com/payments/ach-direct-debit)). So:
  - CRX blocks a new refund while a dispute is open.
  - If a dispute arrives while a refund is pending or after it succeeded, CRX marks both as one exception for staff, and the invoice balance changes only once.
  - Staff then recover the double credit from the customer, as the accountant's rule says. CRX records it as a new linked charge to the customer, for example a misc-charge invoice with a "refund recovery" charge type, so it syncs to QuickBooks like any invoice. That charge type has to be added to CRX's charge list.
  - We also tell customers when a refund is coming, as Stripe suggests, so they don't dispute it too.

### 5.5 Fees and bank deposits

**Plan:** a **"Stripe Clearing"** bank-type account in QuickBooks that mirrors the Stripe balance, so every Stripe event is booked exactly once. Settle it with the accountant.

| Stripe event | QuickBooks entry |
|---|---|
| Payment settled | Customer payment deposited **to Stripe Clearing** |
| Fee | Stripe Clearing → Merchant fees expense |
| Refund | Paid out of Stripe Clearing against the customer |
| Dispute or ACH return | Money taken out of Stripe Clearing against the customer, plus its fee |
| Dispute won | Money put back into Stripe Clearing, plus a fee reversal if Stripe returned the fee |
| Payout | A transfer from Stripe Clearing to the real bank account, for exactly the payout amount |

- After each payout, Stripe Clearing should equal Stripe's remaining balance. A refund is booked only once, from Stripe Clearing, and never also as a deposit line, so nothing is counted twice. This is test case 10.
- If Stripe ever pulls money from the bank directly, because the Stripe balance went negative, that is booked as a transfer from the bank into Stripe Clearing.
- This replaces the usual "Undeposited Funds plus deposit" flow, because Conductor's deposit docs don't confirm negative fee lines ([deposit docs](https://docs.conductor.is/api-ref/qbd/deposits/create)).
- The data comes from Stripe's payout reconciliation report, which itemizes every charge, fee, refund and dispute per payout but works only with automatic payouts ([report](https://docs.stripe.com/reports/payout-reconciliation)). It can also come from the balance records for each payout ([payout reconciliation](https://docs.stripe.com/payouts/reconciliation)).
- The bookkeeper ties each payout ID to the bank line.

**Prices** ([pricing](https://stripe.com/pricing), [local methods](https://stripe.com/pricing/local-payment-methods)):

| Method | Fee | On a $20,000 invoice |
|---|---|---|
| Card | 2.9% + 30¢ | about $580 |
| ACH | 0.8%, capped at $5 | $5 |

So large invoices should be steered to ACH. Card surcharges are allowed only on credit cards, up to 3%, with disclosure and state-law limits. Stripe's surcharge feature is still a preview ([surcharge](https://docs.stripe.com/payments/cards/surcharge)). Get legal review before using it.

### 5.6 Sign-up questions (Mason asks Stripe, in writing)

1. "We are a licensed agricultural chemical distributor. We sell general-use and **restricted-use pesticides** (which need a certified applicator), plus fertilizer, to farm businesses, and we deliver before payment. Are we eligible for Stripe Payments and ACH Direct Debit?" Ask for the answer **in writing**. Stripe may review an account after activation ([ACH docs](https://docs.stripe.com/payments/ach-direct-debit)).
2. "Our invoices run from about $X up to $50,000 or more. What per-payment and weekly ACH limits will we start with, and how do we raise them?" Stripe publishes no default limits ([limits](https://support.stripe.com/questions/bank-debits-transaction-size-and-weekly-volume-limits)).
3. "Will you hold a reserve? On what terms?"
4. Be ready with:
   - EIN and owner details;
   - a website showing products, contact details, and refund and terms policies;
   - state dealer licenses;
   - typical and largest invoice;
   - monthly volume and the expected card/ACH split;
   - return and bad-debt history.

### 5.7 Test mode

- Stripe test cards and test bank accounts cover success, decline, processing, return and dispute ([testing](https://docs.stripe.com/testing)). For example, ACH account `000555555559` simulates a dispute and `000000000009` stays processing.
- Test payments settle instantly, so the 4-day ACH wait is tested with the "stays processing" account.
- One small real card payment and one small real ACH payment run only after Mason approves each one in that conversation (Goal 7 text).

---

## 6. What is still unconfirmed (to prove in the test, not assume)

- Whether QuickBooks lets a payment be voided, or only deleted or edited, through the connector (test case 6).
- Whether updating an existing payment's invoice list adds to it or replaces it (test case 4).
- Whether the Stripe Clearing entries (fee, refund, payout transfer) can all be written through the connector (test case 10).
- Whether Conductor grants a free exemption for the test copy.
- What Conductor does with a write whose reply was lost (test case 7).
- The end-of-support date for QuickBooks Desktop 2024.
- Stripe's eligibility decision, ACH limits and reserve.
- The exact Stripe event set for each reversal path.

## 7. Next steps

1. **Mason:** answer 3.5, and send Stripe the questions in 5.6 (this week).
2. **Mason:** send the accountant sections 4.2 and 4.3, and ask for the five decisions plus confirmation of the supported version.
3. **Mason:** run his part of 3.4 once the answers are in. Then the developer or agent runs the test cases on the copy, before 2026-11-15.
4. **Senior developer** (engaged in October, per 6d): review sections 3.3 and 5 before any code is written.
