# CRX Manager — To-Do (moved)

The to-do list now lives in **[`docs/manual/TO_DO_LIST.md`](docs/manual/TO_DO_LIST.md)**: the CRX Manager To-Do List, in the build order Mason approved on 2026-10-22.

Every item that was still open here on 2026-10-22 was checked against the code and folded into that list (Mason: "yes fold it all in"). It went in as a numbered row, a CAN-WAIT or tooling entry in its section 17, or an open question for Mason. This file's "Not building" list moved there too. The full old list is in git history (this file as of `f4dd40937`).

## Where each old section went

Older docs still say "see `TODO.md` §N". Use this map:

| Old section | Now in `docs/manual/TO_DO_LIST.md` |
|---|---|
| "Next section of work" (pricing, cost tracking, quote pricing) | Section 0 (rows 0.1–0.7), rows 1.2 and 1.3 |
| §1 Owner actions | Backups and staging 13.1, 13.2, 13.7; Stripe 14.4; Mason's readiness tasks 15.1–15.5; category remap 0.12; vendor-name merges 0.16; and the questions in "What Mason needs to decide" |
| §2 Engineering, Now / Next | The numbered rows in sections 0–16; field-application work under section 17 |
| §3 Parked / deferred (grower portal, earmark engine, inventory costing, EPA auto-fill and others) | Section 17: "Later features", "Not doing", and decision 12 for inventory costing. The grower portal comes after rollout. |
| §4 Surfaced by the 2026-07-16 docs review | Section 17, "Screens and polish" |
| §5 Carried over by the 2026-09-26 docs cleanup | Rows 0.12–0.16, 1.6–1.12, 2.7, 3.9–3.10, 4.6, 6.7–6.9, 8.4, 9.6–9.9, 10.5, 11.7–11.8, 15.4–15.5 and 16.10, plus section 17 |
| "Not building" | Section 17, "Not doing" |

Don't add new items here. Add them to `docs/manual/TO_DO_LIST.md`; the detail of a known bug goes in `docs/manual/KNOWN_ISSUES.md`.
