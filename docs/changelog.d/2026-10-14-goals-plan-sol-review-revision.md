## 2026-10-14 - Goals plan revised after an independent Sol 6.1 review

Documentation only; no app or database change.

- **`docs/plans/2026-10-13-direction-and-goals.md` revised.** Mason asked Codex `gpt-6.1-sol` (high reasoning) to review the plan and help edit it. Its 43 findings were checked against the code at `395bdcd9a` and the live system before being applied. Main changes:
  - Goal 2's main change is marked shipped (PR #907), with its follow-ups listed: the own-name rule on every invoice path, reps reading every invoice, and commission splits.
  - React 19 is recorded as done.
  - Retiring Chem Man now depends on a 30-day reconciled pilot and signed opening balances, not just finished features.
  - Three launch-readiness items are listed: compliance (L1), physical inventory (L2), and opening balances and cut-over (L3). Mason later made these his own business tasks, with no code and no gate.
  - Goal 6 (the test system and backups) and Goal 7's outside lead times (accountant, QuickBooks Desktop connection test, payment processor) start now, in parallel.
  - Proposed dated checkpoints and a more honest timeline (roughly 14–25 weeks for Phase A).
  - A proven connector or Intuit's Web Connector is preferred over IIF import files for QuickBooks Desktop.
  - The accounting map needs the accountant's approval before coding.
  - Much fuller "done when" tests for posting, voids, pricing, split billing, reports, offline delivery, recovery and payments.
  - Photo privacy must not rely on expiring links alone.
  - Goal 9 cleanup can never force-apply a migration or switch off a required gate.
  - Six new questions (6f–6k), which Mason answered the same day.
- **Mason's answers, 2026-10-14** (new `docs/manual/DECISION_LOG.md` entry; the goals doc's dates, checkpoints and tests updated to match):
  - Chem Man's last new bill is 2026-12-31.
  - From 2027-01-01 all billing runs in CRX, and the first 30 days are a daily-reconciled pilot.
  - Products are billed only when delivered; money paid in advance is prepay.
  - 6e confirmed: invoices made from scratch carry no product lines, only service or misc charges (its own `DECISION_LOG.md` entry). The `KNOWN_ISSUES.md` owner decision is marked decided; database enforcement is Goal 3.
  - Mason Wells owns compliance and inventory.
  - An overnight outage is acceptable.
  - Only admins change commission splits. This tightens the PR #907 customer-split rule and the job-split rule, as a follow-up code change.
  - The compliance, inventory and opening-balance checks (L1–L3) are Mason's own business tasks, with no code and no agent gate.
- Review fixes:
  - Goal 2 tests that create invoices, email or documents run on the test system, not live.
  - A blank salesperson is stamped with the rep's own name, as shipped, not refused.
