## 2026-10-27 - CodeRabbit check run with an unreadable PR link is "unknown" (#1125, Luna)

A completed CodeRabbit review run whose CodeRabbit link cannot be read no longer lets the gate
conclude "CodeRabbit never reviewed this PR", so Sol cannot run first on it; a trailing `/` after
the PR number in the link is accepted. Luna's BLOCKER that the older commit-status signal is not
PR-bound was refuted: Mason accepted that limit on 2026-10-21 (`coderabbit-native-review.md`).
