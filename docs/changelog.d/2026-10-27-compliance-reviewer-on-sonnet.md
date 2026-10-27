## 2026-10-27 - compliance-reviewer runs on Sonnet

- Mason asked to downgrade the `compliance-reviewer` agent (from the 2026-10-26 efficiency review). Its model moves from `opus` to `sonnet`; its effort stays `high` because it checks money rules, and the tuning rules forbid lowering effort on a money path. Recorded in `docs/reference/claude-model-tuning.md`.
