## 2026-10-26 - One CodeRabbit review per PR: narrow fixes for a minor-only review keep it

Mason: "no need to re review coderabbit again if only minor issue found". CodeRabbit's
allowance is per developer identity and drops to one review an hour at 80+ reviews a week;
its dashboard showed 120 in 7 days, 93% on PRs reviewed more than once.

- `.claude/hooks/codex-bot-review-lib.mjs`: `readMinorFollowUp()` lets a money or
  Mason-named PR keep CodeRabbit's review across narrow fixes when every finding was Minor or
  Trivial (fix chain proved by parent SHAs, review read by id with its finding count matched,
  severity from each finding's header, pre-merge checks bound to the reviewed commit, file
  types and modes checked, size and path limits). Three outcomes: covered, not covered (names
  the failed condition), unreadable (retry; never spend a review on it).
- The merge gates and the migration landing gate get it through `readCodeRabbitRequirement()`;
  the advisory budgets rose from 12 to 15 seconds (Claude) and 5 to 7 (Codex) for its two to
  four extra reads (about 5 seconds measured).
- `scripts/write-codex-push-proof.mjs`: Sol may run before CodeRabbit's first review, and when
  a head is covered this way the Sol prompt shows the fixes and the findings they answer.
- Tests replay real GitHub answers for PRs #1017, #1099, #1101, #1065 and #1086
  (`.claude/hooks/fixtures/coderabbit-followup/`) and break each condition in turn.
- Rules: `docs/reference/coderabbit-native-review.md` items 6-9; AGENTS.md, ship.md, the
  codex-review skill, agent-guardrails, the AI tooling guide and DECISION_LOG updated.
