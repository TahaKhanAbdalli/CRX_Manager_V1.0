## 2026-10-26 - One CodeRabbit review per PR: Sol gets the complete fixes (#1125, Codex App P2)

`scripts/write-codex-push-proof.mjs` now writes the complete, unclipped CodeRabbit findings and
fix diffs to `FOLLOWUP_EVIDENCE.md` inside Sol's sanitized review packet whenever a head is
accepted through a minor-only review. The prompt keeps its capped excerpts and points Sol at the
file, so a long fix or an excerpt past the prompt budget is still reviewed in full.
