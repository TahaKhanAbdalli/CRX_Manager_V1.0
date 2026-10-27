## 2026-10-26 - One CodeRabbit review per PR: "never reviewed" needs the whole commit list (#1125, Codex App P2)

The CodeRabbit requirement read sees only a PR's last 100 commits. It now reports "never
reviewed" only when that list is complete; a longer PR with no review in view is "unknown",
which never lets Sol run before CodeRabbit's first review. A review in view still counts.
