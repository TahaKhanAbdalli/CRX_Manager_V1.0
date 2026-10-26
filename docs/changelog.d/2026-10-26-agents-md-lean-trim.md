## 2026-10-26 — AGENTS.md and CLAUDE.md trimmed to rules, mechanics left to routed docs

- AGENTS.md drops step-by-step delivery mechanics that already live in routed documents: the
  Sol documentation-only landing conditions (`docs/reference/sol-exempt-paths.md`), the
  `--carry-forward` command detail (`.claude/skills/codex-review/SKILL.md` Step 3B), the Luna
  proof-wrapper warning (`docs/reference/codex-model-tuning.md`), the draft-PR and merge-gate
  thread rules (`.claude/commands/ship.md`, `docs/reference/coderabbit-native-review.md`), and
  the one-PR-per-session documentation-records rule (`ship.md`). Each rule keeps a one-line
  statement or pointer; no policy changed. Duplicate "never pause to ask" wording folded into
  the existing no-nudge rule.
- CLAUDE.md drops a Graphify sentence the Graphify skill already states.
- Proof: `node scripts/check-agent-guidance.mjs` and `npm run test:agent-workflows` pass;
  AGENTS.md went from 1,710 to 1,537 words. Not verified: `npm run agent-health` fails only
  on this worktree's `core.hooksPath`, which is unrelated to the edit.
