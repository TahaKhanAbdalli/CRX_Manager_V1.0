---
tags: [start-here, goals]
---

# Goals and Vision

← [[Home]]

> Drawn from Mason's recorded decisions, mainly [[plans/2026-10-13-direction-and-goals|Direction and Goals (Oct 2026)]] and the [[ROADMAP|historical roadmap]]. Where they disagree, the Direction and Goals doc wins. The "In my own words" section at the bottom is Mason's.

## What Crop RX Solutions is

Crop RX Solutions is an ag retailer. It sells crop-protection chemicals, fertilizer and blends to farms, delivers them, and custom-applies them in the field with ground rigs. **CRX Manager** is the company's own app for running all of it: quotes, orders, deliveries, field applications, inventory, invoicing, payments, commissions and compliance records.

## The big goal

**Run Crop RX Solutions as a $10 million-a-year business on CRX Manager.**

In practice:
- Every quote, order, delivery, invoice and payment for the season lives in CRX.
- The numbers are complete and correct, and the totals reach the accounting books (QuickBooks Desktop) without retyping.
- Customer and compliance data is visible only to the people who should see it.
- A bad day (a bug, a lost database, an outage) costs hours, not weeks. CRX is back up by the next business morning.

## The near-term milestone: leave Chem Man

- **2026-12-31**: Chem Man (the software we bill in today) issues its last new bill.
- **2027-01-01**: all billing runs in CRX. The first 30 days are a pilot, reconciled every day.
- **Done when** the pilot is signed off and the spring 2027 season is billed entirely in CRX.

## What "great" looks like (the longer road)

These ideas come from the June 2026 strategic review. Most are after the January launch.

1. **Customers pay online.** Card and ACH through Stripe, starting with a "pay this invoice" link. A grower portal (customers log in to see balances, statements and invoices) comes after rollout.
2. **Compliance on autopilot.** Restricted-use pesticide checks, license expiry, worker-protection sheets and weather at application time, built from data CRX already captures.
3. **Bill from the machine.** Read as-applied files from the sprayer (ISOXML) so every acre applied gets billed. Later, pull data automatically from John Deere and FieldView.
4. **AI paperwork.** Read vendor bills and price sheets automatically.
5. **Profit per field.** Margin per acre for each field, customer and season.
6. **Maybe sell CRX to other retailers.** A deliberate, funded decision for later, not now.

## How we work (principles Mason has set)

- **Correct money beats speed.** No security, money, inventory or compliance defect is accepted just to hit a date.
- **The database enforces the rules,** not just the screen.
- **Single company, web app on phones and PCs.** No native phone apps. CRX is the ledger and syncs to QuickBooks Desktop.
- **Spend on product, not process.** Target at least 3 product changes for every 1 tooling change.
- **Before the January launch, an outside senior developer reviews everything** and signs off in writing.

## In my own words

> *Drafted by Claude from Mason's past conversations and recorded decisions, for Mason to approve or edit (2026-10-28).*

**Why I'm building this.** I run an ag retail business, and we farm too. I'm not a software developer by trade. I build CRX because no off-the-shelf system fits how a small retailer like us actually works: quote, deliver, apply in the field, bill, and get paid, with the compliance records done right along the way. Chem Man is excellent at field application, but it was terrible at the rest of what we do: chemical sales, inventory and quoting. We were bending our business around the software. I want software bent around our business: as good as Chem Man in the field, and far better everywhere else.

**What CRX lets me do that Chem Man never could.**
- Handle chemical sales, quoting and inventory properly, the areas where Chem Man was weakest.
- Match Chem Man's field-application strengths. That bar is high, and CRX already covers its field-app features.
- See the whole business in one place: quotes, orders, deliveries, field work, inventory, invoices, payments and commissions, all connected.
- Trust the numbers. The rules for money and inventory live in the database, so a double-click or a dropped phone signal can't quietly create a wrong bill.
- Know what to order before we run short, and what each product really costs us.
- Make compliance automatic instead of a pile of paperwork.
- Look and work like modern software, on a phone in the field as well as in the office.
- Keep growing it: charts, automatic weather, job costing, online payments, whatever the business needs next, without waiting on someone else's roadmap.

**Where I want Crop RX to be in 5 years.** A $10-million-a-year business running entirely on CRX, with room to grow past that without a rewrite. Customers who can see their balance and pay online. Every acre we apply gets billed, and data comes straight off the equipment. And maybe, if it makes sense as a business, CRX becomes something other retailers can use too.

**What would make me proud of this app.** January 2027: every bill goes out of CRX, the books reconcile every day, nothing gets retyped into QuickBooks, my staff find it easier than what they had, and an independent senior developer looks under the hood and signs off that it's solid.

**What Taha should know about how I work.**
- I can't read code. Explain things to me in plain English: what changes, why, what could go wrong, and how you proved it works. Give me one recommendation, not a menu.
- Wrong money worries me most: a wrong bill, wrong inventory or lost data. Correct beats fast, every time.
- "Done" means you ran it and saw it work, not just that the tests passed.
- Make the technical calls yourself. Ask me about business decisions and risk trade-offs.
- Always ask me first before anything you can't undo: changing the live database, deleting data, deploying, or touching money, security or accounts.
- Our decisions are written down in the Decision Log. Check it before re-opening a settled question.
- The repository is public. Never put secrets or customer details in it.
