## 2026-10-23 — Sol runs only on a quiet head

- `scripts/write-codex-push-proof.mjs`: a full Sol run first checks the head is quiet and refuses,
  with no Codex call, unless an open non-draft PR has this exact commit as its head; the Codex
  GitHub App's summary comment shows a completed review of it (or 15 minutes have passed with none
  since the later of the push and the PR's last switch to ready; a review of it still running waits
  until its summary has not changed for an hour); no Codex App thread on it and no CodeRabbit thread is unanswered; CodeRabbit is not
  mid-review; and a money or Mason-named PR has CodeRabbit's completed review or Mason's skip
  waiver. Unreadable answers refuse. `--dry-run` prints the decision; `--carry-forward` skips it.
  It reuses the merge gate's predicates in `.claude/hooks/codex-bot-review-lib.mjs`.
- Why: of the commits pushed after a PR was marked ready (78 code PRs, 2026-10-14 to 10-23), 32%
  answered the Codex App and 23% answered CodeRabbit, so Sol proofs were voided by late bot
  findings and paid for again (Mason, 2026-10-23).
- Proof: run against all five open PRs, it refused each for its real reason (draft, App not done,
  CodeRabbit mid-review, money PR without its CodeRabbit review); on #1069's real GitHub data it
  allowed Sol. Unit tests cover each condition.
- Docs: `ship.md` Step 8 item 4, `codex-review` skill Step 3B, `agent-guardrails.md`, `DECISION_LOG.md`.
