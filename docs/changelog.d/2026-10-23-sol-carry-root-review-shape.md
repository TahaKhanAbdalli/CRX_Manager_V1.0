## 2026-10-23 — a carried Sol proof's original review must be well-formed

- `.claude/hooks/codex-push-lib.mjs`: `proofValid()` now accepts a carried Sol proof only when its
  `carry.root_review` names a real 40-character head and base and is dated no later than the
  carry itself, in addition to being inside the 24-hour window. Before, only the root timestamp
  was read, so malformed carry metadata could claim a fresh original review (Luna round 1, MED,
  on the 24-hour Sol window change).
- Proof: new cases in `codex-push-lib.test.mjs` (missing root head, short root base, root dated
  after the carry) fail; carries minted by the real `buildCarryForwardProof` still pass
  (`write-codex-push-proof.test.mjs`).
