## 2026-10-26 - One CodeRabbit review per PR: Luna round 1 fixes (#1125)

- Merges after the fixes are now proved to bring in only the base: the PR's own changes against
  the base (status, blob, rename source) must match at the last fix and at the head, so a merge of
  any other branch is refused (shared `docs/**/*.md` ledgers excepted).
- Every other CodeRabbit review of the reviewed commit must be a plain thread reply; one with
  findings of its own or a non-comment state refuses.
- Test files inside agent tooling or CI stay excluded; only `scripts/smoke/` chains are allowed.
- A PR past one read's 100 reviews, review comments or PR comments is "not covered" instead of
  retried forever; a review body with two finding-count lines is not trusted.
- The Codex merge gate test now proves a malformed or timed-out follow-up read refuses.
