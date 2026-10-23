## 2026-10-22 — the migration landing gate finds a waiver recorded at the checkout root

- `migration-landing-gate-lib.mjs` now looks for Mason's per-PR CodeRabbit waiver in the apply's folder, the checkout
  root (`git rev-parse --show-toplevel`) and the session's project folder (`CLAUDE_PROJECT_DIR`), the places the prompt
  hook records it; an apply run from a subfolder no longer misses a valid waiver (Codex App P2 on PR #1035).
