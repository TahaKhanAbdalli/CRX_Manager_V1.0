## 2026-10-25 — Sol refuses a head that does not contain origin/main

- `scripts/write-codex-push-proof.mjs`: the Sol pre-flight now also refuses, with no Codex call, when
  HEAD does not contain the exact `origin/main` the review pins (read once, before the check). That
  ref is shared by every worktree, so another session's fetch can move it past the branch between
  `git merge origin/main` and the Sol run; a clean review of a head that lacks its base can neither
  merge (GitHub reports BEHIND) nor be carried forward, so it was paid for again.
- Why: PR #1075 paid for five full Sol reviews on 2026-10-23 for this reason (Mason, 2026-10-25:
  "make a full Sol run refuse when the branch doesn't contain the latest main").
- Proof: unit tests plus a real-Git fixture (a head missing a moved main refuses; a head containing
  it passes); the dry-run on a branch behind origin/main refuses with the merge instruction.
- Docs: `ship.md` Step 8 item 4, `codex-review` skill Step 3B, `agent-guardrails.md`.
