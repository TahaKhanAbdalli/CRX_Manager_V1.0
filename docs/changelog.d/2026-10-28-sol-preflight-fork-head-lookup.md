## 2026-10-28 — Sol pre-flight finds the pull request of a fork-pushed head

- `scripts/write-codex-push-proof.mjs` asks GitHub which open pull request has the head commit
  before it spends a Sol review. GitHub's commit-to-pull-request association can answer an empty
  list for a head that was pushed from a fork even though its pull request is open (PR #1167 under
  the organization), which made the pre-flight refuse every time; it is also paginated.
- Every lookup (the first read and the final re-read of the head) now reads the canonical
  repository's complete open pull-request list (every page) and matches by exact 40-hex head SHA,
  open state and base repository. The association endpoint is no longer used.
- Fail-closed: two matches (on any page), a closed pull request, another base repository, another
  SHA, an invalid head SHA or repository name, a failing or non-JSON answer, a page that is not a
  list, or any entry without a number, state, 40-hex head SHA or base repository (on any page)
  all refuse. A head that moved or turned ambiguous at the final re-read refuses. A pull request is
  never inferred from a branch name, and no other repository is consulted.
- No other pre-flight condition, merge gate or proof rule changed.
- Proof: `scripts/write-codex-push-proof.test.mjs` runs the lookup and `readSolPreflightFacts`
  against a fake GitHub that fails the test if any endpoint but the open-PR list is read, for a
  head on a later page, no match, ambiguous matches across pages, a wrong or invalid head, a closed
  pull request, a wrong base repository, malformed entries and pages (including on a later page),
  failing answers, and a head that moves, turns ambiguous, changes pull request or fails to read
  between the two reads.
