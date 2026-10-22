## 2026-10-21 — draft "must work on day one" list for the 2027-01-01 CRX-only billing start

- New `docs/plans/2026-10-21-day-one-must-work-list.md`: every workflow and role that has to work on
  2027-01-01 (quote to payment, prepay and credits, split billing, field/job/blend invoices, returns,
  commissions, statements and emails, reports, security, the year boundary, backups and recovery,
  QuickBooks and Stripe with their contingencies, Mason's L1-L3 tasks, and launch readiness: the
  November-December trial, the senior developer, cut-over, the daily pilot check and the emergency brake).
  Each row has today's status and evidence, the goal that closes it, and a MUST / SHOULD / CAN-WAIT rank.
  It ends with six decisions for Mason.
- Revised after an advisory Codex `gpt-6-sol` (high) review of the first draft (57 findings, each checked
  against the goals doc and the code). A source check also corrected the year-boundary section: the season
  changes on October 1 (`src/utils/season.ts`), so only quote and order numbering is a January 1 risk.
- Statuses refreshed against `main` at `d720cf681` (2026-10-22) after the Codex GitHub review: PO cost live (#980),
  file backup and freshness check built but not live, the Goal 7 groundwork (Stripe eligibility risk), and the Goal 4
  done-test items (pickers, paging, workload test, 200+ payment history) raised to MUST.
- Draft for Mason's approval by the 2026-10-31 checkpoint. Documentation only; no code or database change.
