## 2026-10-14 — docs cleanup, part 1: status notes and broken links (documentation only)

First of two documentation-cleanup PRs. Every change below was checked against git history or
the files it points to; nothing changes how the app or the agents behave.

**Status notes added** to documents whose stated status no longer matched reality:

- `docs/plans/2026-08-18-product-data-model-plan.md` — superseded as the executable plan by
  the 2026-08-19 build plan; build not started.
- `docs/plans/2026-09-11-open-pr-backlog-plan.md` — the queue is complete.
- `docs/plans/2026-06-14-portal-roadmap-build-vs-reuse-audit.md` — point-in-time audit; the
  portal is still deferred.
- `docs/handoffs/2026-08-12-live-sql-guard-maintenance-build-to-review.md` — superseded; the
  producer was retired unrun (#619, #622).
- `docs/reports/2026-09-11-guard-denial-baseline.md` — frozen baseline; no 2026-09-25
  re-measure is recorded.
- `docs/research/2026-07-25-opus5-harness-review.md` — its last open P1 landed in #228.
- `docs/audits/per-line-split-billing-CODEX-REVIEW-RUNBOOK-2026-07-20.md` — historical; the
  feature shipped (#164, #244).

**Broken links repaired** (80 links in four audit files): repo-root paths written from inside
`docs/audits/` and absolute `C:/CRX_Manager/...` paths were unreadable on GitHub. The 79 links
that cite a line number (`:LINE`) are now GitHub permalinks pinned to the commit that added each
audit (`86e9391b3`, `95dffee7f`, `c6de9b4ba`), so the line numbers still point at the code and
plans the audit described; the one same-folder link (`overnight-bug-hunt/REPORT.md` →
`LEDGER.json`) is now relative.

**Deleted-plan reference** (separate fix): in `docs/audits/2026-06-18-as-applied-overnight-handoff.md`
the link to a plan removed in #139 is replaced by the `git show` command that recovers it.

Skipped because another open PR changes them: `docs/manual/ARCHITECTURE.md`,
`CURRENT_STATE.md`, `KNOWN_ISSUES.md`, `DECISION_LOG.md`, the 2026-10-13 direction and pricing
plans, the product-data build plan, and the 2026-10-13 branch-cleanup audit.
