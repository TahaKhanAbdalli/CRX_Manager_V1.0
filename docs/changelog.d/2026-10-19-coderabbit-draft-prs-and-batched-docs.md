## 2026-10-19 — PRs open as drafts; review fixes and documentation records are batched

- `.claude/commands/ship.md` Step 8: open every PR with `gh pr create --draft` and mark it ready once with `gh pr ready <n>` after the head is frozen and checks are green; put all fixes for one review round in one push; collect one session's documentation-only records in a single draft PR.
- `AGENTS.md`: one sentence on the CodeRabbit line stating the same rule.
- `docs/manual/DECISION_LOG.md`: new 2026-10-19 entry with the reasoning. The 200 PRs merged from 2026-09-02 to 2026-10-18 produced about 846 CodeRabbit review events, which dropped the plan's allowance to 1 review an hour.

Proof: this PR was opened as a draft and then marked ready with `gh pr ready`, following the new steps. Not verified: how many reviews the rule saves over a full week. Check that after a week of use.
