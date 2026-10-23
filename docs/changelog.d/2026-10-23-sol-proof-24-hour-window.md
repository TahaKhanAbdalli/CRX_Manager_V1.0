## 2026-10-23 — a clean Sol review lasts 24 hours on an unchanged head and base

- `.claude/hooks/codex-push-lib.mjs`: `proofValid()` accepts a clean Sol proof for 24 hours
  (`SOL_PROOF_MAX_AGE_MS`) instead of 30 minutes. The exact-head and exact-base binding is
  unchanged, so a new commit or a moved main still voids a proof at once. A carried-forward proof
  must also have its original full review (`carry.root_review`) inside the same 24 hours.
  Codex's Claude-review proofs keep 30 minutes (`CLAUDE_PROOF_MAX_AGE_MS`).
- `.claude/hooks/migration-landing-gate-lib.mjs`: a live migration apply still needs the PR's
  Sol proof under 30 minutes (`APPLY_SOL_PROOF_MAX_AGE_MS`); the apply proofs are unchanged.
- `scripts/write-codex-push-proof.mjs`: `CARRY_SOURCE_MAX_AGE_MS` now reuses the same 24 hours.
- Why: reviews of unchanged code expired while the PR waited to merge, and carry-forward refuses
  when main has not moved, so each one cost a full new Sol review (Mason, 2026-10-23).
- Proof: a proof minted by the real builder at 5 min / 31 min / 90 min / 23 h / 25 h old — the old
  gate accepted only the 5-minute one; the new merge gate accepts all but 25 h; the migration-apply
  gate still accepts only 5 minutes; a moved base or a new commit is still refused; a carry made
  now from a 23-hour-old review passes, and fails once that review passes 24 hours.
- Docs: `codex-review` skill Step 3B, `ship.md`, `agent-guardrails.md`, `DECISION_LOG.md`.
