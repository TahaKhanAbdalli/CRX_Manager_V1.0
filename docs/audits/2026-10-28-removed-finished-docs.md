# Finished docs removed — 2026-10-28

Mason asked for a docs cleanup on 2026-10-28: remove finished or no-longer-relevant documents so the
repository's docs stay current. Each file below described work that was already finished, closed,
or replaced, and its own header said so. Nothing current depends on them.

Git still holds every one. To read or restore a file, use the last commit that had it:

```bash
git show 5b0246530:docs/audits/2026-09-02-github-branch-cleanup-audit.md
```

```bash
git checkout 5b0246530 -- docs/audits/2026-09-02-github-branch-cleanup-audit.md
```

Where another document mentioned a removed file, the mention now says "removed 2026-10-28" and
points here. Raw `git status` output quoted inside older audits was left as recorded.

## Branch and worktree cleanup records (all cleanups finished)

| File | Why it went |
|---|---|
| `docs/audits/2026-07-27-branch-worktree-cleanup-restore-ledger.md` | July branch cleanup; executed. Restore tags it names stay on `origin`. |
| `docs/audits/2026-07-29-branch-worktree-cleanup-restore-ledger.md` | Second July cleanup; executed. Restore tags it names stay on `origin`. |
| `docs/audits/2026-08-31-branch-inventory-for-codex-review.md` | Branch inventory feeding the September cleanup; used. |
| `docs/audits/2026-08-31-stash-and-object-store-cleanup-not-worth-doing.md` | Recorded a decision not to act; nothing pending. |
| `docs/audits/2026-09-01-closed-pr-branch-disposition-plan.md` | September cleanup plan; carried out. |
| `docs/audits/2026-09-01-no-pr-branch-disposition-plan.md` | September cleanup plan; carried out. |
| `docs/audits/2026-09-01-no-pr-branch-restore-ledger.md` | September deletions; executed with Mason's approval. Restore tags stay on `origin`. |
| `docs/audits/2026-09-02-github-branch-cleanup-audit.md` | September GitHub branch audit; its follow-ups were filed in `KNOWN_ISSUES.md` and `DECISION_LOG.md`. |
| `docs/audits/2026-09-03-landed-and-retired-branch-restore-ledger.md` | Five branch deletions; executed. Restore tags stay on `origin`. |
| `docs/audits/2026-09-03-merged-pr-leftover-restore-ledger.md` | Six branch deletions; executed. Restore tags stay on `origin`. |
| `docs/audits/2026-10-13-github-branch-cleanup-audit.md` | October branch audit; deletions done. |
| `docs/audits/2026-10-14-github-branch-cleanup-outcome.md` | Outcome of that October cleanup. |

## Replaced or abandoned work

| File | Why it went |
|---|---|
| `docs/audits/2026-08-24-claude-to-codex-pr432-ci-handoff.md` | PR #432 closed unmerged; header said "superseded". |
| `docs/audits/2026-08-24-codex-to-claude-dynamic-hardlink-bypass-handoff.md` | PR #432 closed unmerged; header said "superseded". |
| `docs/audits/2026-08-24-pr432-park-handoff.md` | PR #432 closed unmerged; header said "superseded". |
| `docs/audits/2026-08-08-product-pricing-full-audit-and-strategy.md` | PR #350 closed unmerged; header said "superseded". The below-cost work shipped another way. |
| `docs/audits/gauntlet/2026-07-25-section-10-blend-ticket-ocr-refresh.md` | Replaced by the 2026-07-28 Section 10 report. |
| `docs/audits/gauntlet/2026-07-25-section-12-edge-functions-refresh.md` | Replaced by the 2026-07-28 Section 12 report. |
| `docs/plans/2026-08-18-product-data-model-plan.md` | Replaced as the working plan by `2026-08-19-product-data-model-BUILD-PLAN.md`. |

## Finished handoffs and closeouts

| File | Why it went |
|---|---|
| `docs/audits/2026-06-18-as-applied-overnight-handoff.md` | June overnight build report; the as-applied work shipped. |
| `docs/audits/2026-07-18-claude-to-codex-phase1b-golive-execution.md` | Phase 1b go-live; header said "execution complete". |
| `docs/audits/2026-07-22-codex-to-claude-supplier-pricing-phase3-handoff.md` | Supplier pricing Phase 3; closed (PRs #246, #282). |
| `docs/audits/2026-07-22-supplier-cost-basis-phase2-wells-canary-closeout.md` | Phase 2 canary closeout; done. |
| `docs/audits/2026-07-25-codex-to-claude-phase3-stage-b-handoff.md` | Phase 3 Stage B; landed. |
| `docs/audits/2026-07-26-supplier-pricing-phase3c-owner-review-summary.md` | Phase 3C review; PR #246 merged. |
| `docs/audits/2026-07-30-ap-period-close-boundary-hardening-closeout.md` | Bills period-close work; header said "COMPLETE". |
| `docs/audits/2026-07-30-vendor-bill-period-close-lock-closeout.md` | Vendor-bill period lock; closed out. |
| `docs/audits/2026-08-12-codex-to-claude-returns-credit-rollout-handoff.md` | Returns/credit rollout; all four findings fixed live (Section 8 report). |
| `docs/audits/2026-09-03-claude-review-of-pr-comment-audit.md` | September PR-comment audit review; finished. |
| `docs/audits/2026-09-03-codex-to-claude-pr-comment-audit-handoff.md` | Handoff for that review; finished. |
| `docs/audits/per-line-split-billing-CODEX-REVIEW-RUNBOOK-2026-07-20.md` | Per-line split billing shipped in PR #164; header said "historical". |
| `docs/handoffs/2026-07-18-gauntlet-2-6-leftover.md` | Header said "completed/superseded". |
| `docs/handoffs/2026-08-12-live-sql-guard-maintenance-build-to-review.md` | Header said "superseded; nothing below is actionable". |
| `docs/handoffs/2026-09-12-pr-comment-session-closeout.md` | September session closeout; finished. |
| `docs/reports/2026-09-11-guard-denial-baseline.md` | One-time baseline; header said "frozen", no re-measure planned. |

## Old idea and design docs Mason chose to drop (2026-10-28)

Mason went through the unbuilt idea and design documents one by one in chat and chose to remove
these. The October goals doc (`docs/plans/2026-10-13-direction-and-goals.md`) and the to-do list
(`docs/manual/TO_DO_LIST.md`) are the current plan.

| File | Why it went |
|---|---|
| `docs/plans/2026-06-14-portal-roadmap-build-vs-reuse-audit.md` | June build-or-reuse audit for the grower portal; its database facts were stale. The portal brainstorm itself is kept. |
| `docs/audits/2026-06-19-future-projects-idea-mining/` (16 files) | June study of six open-source farm and business apps; replaced as a plan by the goals doc. |
| `docs/research/2026-06-19-future-projects-open-source-comparison.md` | Companion to that study. |
| `docs/research/2026-06-10-world-class-deep-dive-report.md` | June product scoring; describes the app as it was then. |
| `docs/research/2026-06-10-world-class-product-deep-dive-prompt.md` | The prompt that produced that report. |
| `docs/audits/split-billing-B-perdelivery-design-2026-07-10.md` | Unbuilt July split-billing design; split billing is now built from the goals doc. |
| `docs/audits/nightly-debug/DESIGN-split-invoices-multifield-by-acres.md` | Unbuilt June split-billing design; same reason. |
