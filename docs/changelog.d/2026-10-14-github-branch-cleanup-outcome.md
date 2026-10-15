## 2026-10-14 - GitHub branch cleanup outcome: all 173 deleted, 12 kept

Documentation only; no code or database change.

`docs/audits/2026-10-14-github-branch-cleanup-outcome.md` records what happened after PR #901 planned the
cleanup:
- The 157 "after yes" branches were deleted on 2026-10-14 with Mason's approval.
- The 16 "after this PR" branches were deleted on 2026-10-15 (UTC) with Mason's approval. Other pull
  requests kept landing on `main` faster than this record could be re-reviewed, so Mason chose to delete
  first and record after.
- Each deleted branch is listed with its restore source, re-verified live.
- The 12 kept branches are unchanged.

PR #901 was squash-merged onto a `main` that already held #910. Its two rescued files therefore carry
the header edits from #910, and helper version 2's byte-identity check could never pass. With Mason's approval,
helper version 3 accepts a difference only when it is exactly `main`'s own clean changes. An independent
review found it clean. The new helper hash and every baseline rewrite are in the outcome record, which
supersedes the ledger's recorded helper hash. The ledger file itself is unchanged, because the helper
requires it to stay byte-identical to the approved PR #901 head.
