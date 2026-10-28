---
tags: [start-here, plans]
---

# Plans and Roadmap

← [[Home]] · see also [[Goals-and-Vision|Goals and Vision]]

> A summary for orientation. The source of truth is [[plans/2026-10-13-direction-and-goals|Direction and Goals]] for goals and dates, and [[manual/TO_DO_LIST|the To-Do List]] for the exact work in build order. Check [[manual/CURRENT_STATE|Current State]] before building anything: plans go stale.

## The four phases

| Phase | What happens | Done when |
|---|---|---|
| **A. Build** | Finish Goals 1–7, including QuickBooks and payments | Each goal passes its "done" test |
| **B. Clean up** | Goal 9: docs, files, branches, AI tooling tidied and explained | A newcomer can find, run and understand everything |
| **C. Hand off** | Goal 10: an outside senior developer reviews the system | Their must-fix list is fixed, and they sign off in writing |
| **D. Roll out** | Chem Man's last bill 2026-12-31, CRX-only billing from 2027-01-01 | The 30-day pilot is signed off |

## The goals

1. **Close the security holes.** Cost and margin are admin-only, photos need a sign-in, the restricted-use register is admin-only. *Mostly live as of late October 2026.*
2. **Reps invoice any customer, under their own name.** *Main change live 2026-10-14; follow-up due 2026-11-30.*
3. **Billing you can trust.** Safe posting, safe retries, voids that credit, quantity caps, split billing.
4. **Complete, correct numbers at any volume.** No reports or lists that stop at a row limit.
5. **Completing a delivery needs a signal.** No half-saved deliveries.
6. **A real safety net.** Supabase Pro with point-in-time recovery, backed-up uploads, tested restores, a staging (test) system.
7. **CRX becomes the system of record.** QuickBooks Desktop sync and Stripe card/ACH payments.
8. **Spend on product, not process.** Ongoing.
9. **Everything tidy and explained.**
10. **Senior developer handoff and review.**

## Build order (Mason, 2026-10-22)

Everything that happens **before delivery** comes first:
1. Pricing and cost tracking, quoting and orders, inventory (knowing what to order), invoicing.
2. Delivering and billing it: deliveries, split billing, payments and prepay, commissions, documents and emails.
3. Complete numbers at volume.
4. Last: everything marked CAN-WAIT (returns, field-application invoices, rep-only rules).

## Key dates

| Date | Checkpoint |
|---|---|
| 2026-10-31 | Test system and backups underway, accountant asked, Stripe sign-up started, senior developer engaged |
| Nov–Dec 2026 | Small real trial: a few customers billed through CRX, quote to payment |
| 2026-11-15 | QuickBooks Desktop connection proven with a real invoice, payment and credit |
| 2026-11-30 | Goals 1, 3, 5, 6 done, plus the Goal 2 follow-up |
| 2026-12-15 | Goals 4 and 7 done; a test month reconciled in QuickBooks |
| December | Senior developer review, cleanup, staff training |
| 2026-12-31 | Last Chem Man bill |
| 2027-01-01 | CRX-only billing; 30-day pilot begins |

**The timeline is tight.** The estimates add up to more than the weeks available, so work runs in parallel. If a checkpoint slips, Mason gets a revised forecast straight away.

## Parked on purpose (not now)

- Grower portal (after rollout)
- Field-application split billing
- Full offline proof of delivery
- Any new Chem Man features

## Other planning documents

- [[ROADMAP|Historical roadmap]]: strategic ideas A1–F3 and the backlog
- [[roadmap/2026-07-15-roadmap-and-execution-plan|July 2026 roadmap]]: the north star still stands; its priority order was replaced in October
- Folder `plans/`: one document per feature or decision, with dates in the name
- Folder `audits/`: evidence of what was checked and proven
