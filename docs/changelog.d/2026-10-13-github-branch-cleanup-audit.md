## 2026-10-13 - GitHub branch cleanup audit: 191 branches inventoried, 185 audited, Sol 6.1 reviewed, salvage reviewed, records rescued before deletion

Documentation only; nothing was deleted and no code or database changed.

Mason asked to analyze every GitHub branch and remove what is useless, then had Codex `gpt-6.1-sol`
review the proposal first. The report and restore ledger are in
`docs/audits/2026-10-13-github-branch-cleanup-audit.md`.

**How it was reviewed.** A read-only 56-agent workflow measured the 185 branches not owned by an open PR.
It used investigators per topic, two skeptics per delete verdict, a prior-reports reader and a
completeness critic. Sol's review, which Mason made a precondition for deleting, returned BLOCK with 45 findings (5 HIGH) in
round 1. Claude agreed with nearly all of them and revised the proposal. Round 2 found 30 fixed (all five
HIGH) and raised 18 new findings, mostly about the deletion procedure. The revision answering them is in
the report: preservation is verified before deletion, tags are made by an ordinary push, checks run per
branch, there is a post-batch sweep, and a verified local bundle serves as an independent fallback.
Round 3 (BLOCK 18) asked for the deletion steps to be bound to the approved ledger and made reviewable. They
now run through a read-only helper script (kept next to the bundle, with its SHA-256 recorded in the
report). It refuses on any doubt and only prints the commands that change GitHub. Restoring from the
bundle was demonstrated in a separate clone, and 99 of the 177 deletion tips were proved to sit inside a
merged PR's head.

Round 4 (BLOCK 26; the same HIGH findings survived two fix rounds) triggered the project's stop rule, and
Mason chose "fix and go". Version 2 of the helper is described in the report and its SHA-256 recorded
there. It:
- re-runs every gate before each branch's delete;
- binds the repository identity;
- requires the merged docs to be byte-identical to the approved commit, with CodeRabbit APPROVED and the
  required checks green on that commit;
- snapshots the full `protect-main` rules;
- refuses stale or malformed session lists;
- hashes and verifies the bundle.

Bundle recovery was repeated in a brand-new empty repository (185/185, 18,000 objects, 0 missing).
Read-only tests: 21 of 25 exactly as expected, the other 4 also refusals; plus 9 of 9 per-branch cases. Two
review comments on this PR were addressed: the 8.3 wording now names only the measured path, and the
refresh rule now catches changes to files the review already saw.

**Salvage review.** Mason then asked for an adversarial review for work worth reusing, his example being
pricing history and cost tracking for quotes. It ran in two read-only passes of 13 agents each:
- **Pass 1** compared files. It found reusable quote-pricing work on PR #397 and PR #350, and the invoice
  editor's unsaved-edits guard on PR #892, which the audit had wrongly called fully landed.
- **Pass 2** compared every added line with all of `main`: 21,567 lines in 227 groups, each with a verdict.
  It found no further branch to keep.

Mason kept all six branches in question: #397, #350, #892, `backup/pr432-multitarget-20260825`, F3's
`claude/control-file-coverage-a41c` and #449's branch. He also decided that landlord split billing should
work.

**Verdicts.** 173 deletable (157 after Mason's yes, 16 after this PR merges) and 12 kept. Each deletion is
an atomic compare-and-delete, so a newly pushed commit cannot be lost. The helper's sealed counts were
updated to match, and its new SHA-256 is in the report.

**Outcome so far (2026-10-14).** Mason approved the 157 "after yes" batch and it is done: the six archive
tags it needed were created first, and the helper's sweep reported all 157 gone with every restore source
intact. All 12 kept branches are unchanged. Each time `main` moved, the review baseline was re-measured
and rewritten each time, as the report records: at `22c10c8df` (after #900, #903 and #904), `82c8c0817`
(after #906, mid-batch), `395bdcd9a` (after #907), `eec473890` (after #909), `d12fc0f2a` (after #908),
`95f3c563c` (after #905), `5976d3dbc` (after #914) and `ca20e4757` (after #911, #912, #915 and #916).
The report names the snapshot in force for the 16. The 16 "after this PR" deletions are approved
by Mason ("yes delete the 16", 2026-10-14) in the conversation that ran the 157; they wait for this PR to
merge and the helper's gates to pass. Any other session needs a fresh yes from Mason first.

This PR rescues or corrects:

- **`docs/manual/DECISION_LOG.md`**
  - Mason's 2026-08-09 pricing answers. Commission clawback on returns is settled but, per a full
    live-catalog trace, not built (the trace is in `KNOWN_ISSUES.md`). The entry also covers the
    no-backfill boundary and the below-cost wall.
  - The 2026-08-27 ingredient identity model D-AA.
  - The 2026-09-01 return-credit split entry, marked superseded by #544's close.
- **`docs/plans/2026-08-19-product-data-model-BUILD-PLAN.md`**: PR #507's Revisions 12-13, merged in
  by a clean three-way merge with one qualifier added at review (the first concurrency criterion now
  requires the same CAS), plus that PR's changelog fragment.
- **`docs/manual/KNOWN_ISSUES.md`**, new OPEN entries:
  - Two latent quote bugs (re-save refusal; Convert to Order leaving an accepted quote with no order) and a
    display-only quote cost difference, all traced on `main`. Plus the `quote_sections` grants (verified
    live) and the below-cost reason fallback.
  - A HIGH permission gap: connected MCP tools with no ask/deny rule run without a prompt (measured
    against the hooks and both settings files).
  - The review-proof forgery class, with its full limitation.
  - A small-notes list, each item with how it was checked.
  - The salvage review's findings, also each with how it was checked:
    - the landlord split-billing refusal, read from the live trigger, which Mason wants to have fixed;
    - autopilot's delete-spelling gap, reproduced by calling its decision function;
    - two latent billing notes and two stale spots;
    - the profitability database test and pointers to the kept code;
    - a correction: the parked below-cost fix's precondition still matches the live function.
  
  Existing pointers to branches on the cleanup list are reworded to stay true before and after deletion.
- **Stale references:** `docs/manual/CURRENT_STATE.md` (#605/#612/#631 closed) and one changelog citation
  repointed to PR #591.

Proof observed:
- every in-scope branch (185) got exactly one verdict;
- 59 cited successor PRs confirmed MERGED;
- every branch re-measured at `7abd52f6d` after #893 moved `main`;
- four PR refs fetched back to their exact branch tips;
- all 23 applied migrations whose names appear on branches match `main`'s file by the live recorded-SQL
  fingerprint;
- live checks were read-only `SELECT`s.

Not verified: the 8.3 short-name route was not reproduced; the below-cost reason fallback, the Net 30
posting behavior and the return-credit prover were reasoned, not run.
