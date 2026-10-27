## 2026-10-26 — Landing-helper note matches the behind-main rule (Luna round 3)

- `docs/reference/agent-guardrails.md`: the `scripts/land-pr.mjs` paragraph now says its
  `gh pr update-branch` step reacts only to GitHub reporting `BEHIND`, which no longer happens since
  GitHub's up-to-date rule was turned off (2026-10-26), instead of contradicting itself.
