## 2026-10-21 — Agents request one CodeRabbit full review on money and Mason-named PRs

- Mason's decision (2026-10-21): a PR that touches money, invoices, payments, inventory, or costs,
  or one Mason asks a session to have reviewed, merges only with a clean CodeRabbit review of its
  current head as well as the clean Sol review. The agent requests it itself with one
  `@coderabbitai full review` comment on the frozen, green head; Mason no longer posts it by hand.
- Limits: wait for an automatic review still in progress; one request per head, plus one retry
  after a stated rate-limit wait (30 minutes if CodeRabbit is silent), then the PR is reported
  stuck. A qualifying PR drops `docs(` from its title so CodeRabbit does not skip it. Any fix commit prompted by CodeRabbit (code, documentation or configuration) moves the head, so Sol re-runs and one new full
  review is requested. A plain merge of main does not need a new CodeRabbit review.
- Enforced (Mason: "Build the merge-gate enforcement into #1009", after the final Sol review
  refused the written-only version): both agent merge gates and the migration landing gate refuse
  a qualifying PR until CodeRabbit itself marks its head (or an earlier commit followed only by
  merges) "Review completed". A PR qualifies by its files (any migration or Edge Function, or a
  money-named `src/` file) or by the new `needs-coderabbit` label, which agents add when Mason asks
  for a review. New in `.claude/hooks/codex-bot-review-lib.mjs`: `evaluateCodeRabbitRequirement()`
  and friends, with tests in the library, Codex guard, merge-guard and migration-gate suites.
  A dry run on live PRs: money PRs #1010, #1006, #995, #991 read "missing", #981 and #970
  "reviewed", docs and agent PRs (including this one) "not required".
- Every other PR keeps the 2026-10-19 advisory rule: no `@coderabbitai` commands.
- Updated together: `AGENTS.md`, `scripts/check-agent-guidance.mjs` (now checks the new wording),
  `.claude/commands/ship.md`, the `codex-review` and `deploy-check` skills (and their generated
  `.agents/` copies), the hook landing-policy text in `.claude/hooks/prompt-source-lib.mjs`,
  `.coderabbit.yaml` comments, `docs/reference/coderabbit-native-review.md` (full rules),
  `docs/reference/agent-guardrails.md`, `docs/reference/gotchas.md`,
  `docs/workflows/SAFE_DEVELOPMENT_RULES.md`, `docs/manual/DECISION_LOG.md`, `.claude/hooks/codex-bot-review-lib.mjs`, both merge gates and the migration landing gate (plus their tests).
- Review rounds (Luna x3, one advisory Sol) tightened the wording: one request per head (a code
  fix needs a new one), drop `docs(` before marking ready, and the guidance check pins the scope,
  the frozen-green timing, the stated wait, and the one-retry cap.
- Checked: no hook, permission rule, or required check blocks an agent from posting the comment.
  The merge gates still deny any open or unreplied CodeRabbit thread.
