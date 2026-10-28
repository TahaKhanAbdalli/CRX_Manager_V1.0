## 2026-10-28 — Sol pre-flight finds the pull request of a fork-pushed head

- `scripts/write-codex-push-proof.mjs` asks GitHub which open pull request has the head commit
  before it spends a Sol review. GitHub's commit-to-pull-request association can answer an empty
  list for a head that was pushed from a fork even though its pull request is open (PR #1167 under
  the organization), which made the pre-flight refuse every time.
- When the association has no exact match, the lookup now reads the canonical repository's complete
  open pull-request list (every page) and matches by exact head SHA, open state and base
  repository. The final re-read of the head uses the same lookup.
- Fail-closed, unchanged: two matches, a closed pull request, another base repository, another SHA,
  a failing or malformed answer, a page that is not a list, or an entry without a head SHA or base
  repository all refuse. A pull request is never inferred from a branch name, and no other
  repository is consulted.
- No other pre-flight condition, merge gate or proof rule changed.
- Proof: `scripts/write-codex-push-proof.test.mjs` runs the lookup and `readSolPreflightFacts`
  against a fake GitHub for a fork head on a later page, no match, ambiguous matches, a wrong head,
  a closed pull request, a wrong base repository, malformed and failing answers, and a head that
  changes between the two reads; removing the fallback fails it.
