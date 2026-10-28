---
tags: [start-here, chem-man]
---

# Chem Man vs CRX

← [[Home]] · see also [[Goals-and-Vision|Goals and Vision]]

Chem Man is the outside software Crop RX bills in today. Its last new bill is **2026-12-31**, and from **2027-01-01** everything runs in CRX ([[manual/DECISION_LOG|Decision Log]], 2026-10-14). This note says what Chem Man does well, where it falls short, and where CRX stands, so build decisions start from the right comparison.

## The short version

> **Chem Man is excellent at field application and weak at everything else we do: chemical sales, inventory and quoting.** CRX has to be as good as Chem Man in the field and far better everywhere else. (Mason, 2026-10-28)

One way to put it: *Chem Man helps you spray; CRX runs the whole business the spraying is attached to.* Inventory, purchasing, receivables, commissions, compliance records and field maps all live in one database.

## Where Chem Man is strong: field application

This is Chem Man's everyday advantage, and the area CRX copied most carefully:
- scheduling application jobs and dispatching them to applicators;
- recording what was actually applied: acres, applicator, equipment, start and end weather, tach (engine) hours;
- turning a job into an invoice, including splitting one job across several customers or a landlord by share;
- per-acre pricing from a price book, application fees, fuel surcharges;
- printing and emailing field invoices, and notifying the customer before and after spraying.

## Where CRX stands on field application

| When | What happened |
|---|---|
| 2026-06-29 | **41 of 41 Chem Man field-app areas built to parity** (equal to Chem Man) and in production. |
| 2026-06-30 | **Beyond-parity features live:** the Office Cockpit (one screen showing only what's stuck or wrong), a watchdog that flags wrong-field, over-label-rate and double-billing mistakes, an auto-*draft* invoice when a job completes (switched off by default, and never auto-posted), and a "your field was sprayed" proof the office sends to the grower with one tap. |
| 2026-07-01 | **The last two gaps closed:** one-tap weather fill (from Open-Meteo, marked "modeled, not measured") and carrier water per acre on the field invoice. |

The 2026-06-30 go-live left two jobs for Mason: reviewing the AI-drafted label data (REI, PHI, signal word, EPA number, max rate) for the products, and switching on the grower "field was sprayed" email. Check [[manual/CURRENT_STATE|Current State]] for whether they're done.

## Where CRX is already ahead

- **Selling:** quotes, bookings drawn down over the season, price tiers, margin floors with admin approval for below-cost sales.
- **Inventory:** on hand, held and net position from one database function, receiving with lot numbers, cycle counts, purchase orders.
- **Money:** prepay credits, write-offs, finance charges, receivables aging and reminders, voids with a reason, commissions.
- **Compliance:** the Restricted-Use Pesticide (RUP) register with buyer certificates, applicator license tracking, EPA numbers on invoice lines.
- **Fields:** FSA farm, tract and field numbers; drawn or imported field boundaries with measured acres; soil, irrigation and crop history; per-field billing defaults.

## What this means for building

- **The cut-over depends on sales, inventory and money working, not on field app.** Field app is at parity. The [[manual/TO_DO_LIST|To-Do List]] is mostly quoting, pricing, billing correctness and opening balances.
- **Don't break what's at parity.** A change to invoices, jobs or fields must keep the field-app flow working.
- **History stays in Chem Man for now.** Spring 2026 was billed in Chem Man. Those deliveries are recorded in CRX as billed outside CRX, so CRX won't bill them again. What history moves into CRX is still undecided (To-Do 16.4).

Sources: the parity and gap-closeout entries in [[CHANGELOG]] (2026-06-29 to 2026-07-01) and Mason's own words in [[Goals-and-Vision|Goals and Vision]].
