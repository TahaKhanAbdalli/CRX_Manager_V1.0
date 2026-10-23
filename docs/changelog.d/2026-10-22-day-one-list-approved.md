## 2026-10-22 — day-one list approved, renamed the CRX Manager To-Do List, and the old TODO.md folded in

- Mason approved the day-one list (in chat, 2026-10-22) and asked for an easy-to-find name. It moved from
  `docs/plans/2026-10-21-day-one-must-work-list.md` to `docs/manual/TO_DO_LIST.md` ("CRX Manager To-Do List"), with a
  short "how to keep it current" note.
- In the list: marked APPROVED. The small part of cost freshness (an "as of" date on each cost and a stale-cost
  report, row 0.7) is un-parked and MUST; the supplier-evidence rollout stays parked. Row 13.3 records the off-site
  photo and file backup as live (PR #1029). Answered decisions are marked; names are not chosen yet.
- Folded in every still-open item from the old root `TODO.md` (2026-09-27), each checked against the code. Two MUST
  rows: 6.7, payment dates use Chicago's date (`allocate_payment` still defaults to UTC); 8.4, a live proof of the
  commission "as of" report. Also 28 SHOULD rows, CAN-WAIT and tooling lists in section 17, and five new questions for
  Mason. Mason removed four items for good: bank reconciliation, 1099s, reading vendor bills automatically, and profit
  per field. The category remap moved up to SHOULD. The root `TODO.md` becomes a pointer in a separate PR.
- `docs/manual/DECISION_LOG.md`: the 2026-10-22 day-one entry records the approval, the new path, the fold and the
  removals.
- `docs/plans/2026-10-13-direction-and-goals.md`: the 2026-10-31 checkpoint's day-one-list item is marked done.
- Documentation only.
