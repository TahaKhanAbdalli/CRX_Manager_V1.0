## 2026-10-27 - CodeRabbit check-run reads fail closed (#1125, Luna round 2)

A commit read without its CodeRabbit check suites can no longer count toward "CodeRabbit never
reviewed this PR", and Sol's "CodeRabbit is reviewing" wait treats a check-runs page without its
run list, or with fewer runs than GitHub's total, as unreadable rather than "not busy". Luna's
BLOCKER that `CheckRun.summary` is not a GraphQL field was refuted live: the read returned it.
