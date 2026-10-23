## 2026-10-23 — guard messages and reference state the 24-hour Sol window

- `codex-push-guard.mjs`, `pr-merge-guard.mjs` and `.codex/hooks/production-action-guard.mjs` denial
  messages said a Sol proof expires in 30 minutes; they now say it lasts 24 hours on an unchanged head
  and base, matching `proofValid()`. `docs/reference/agent-guardrails.md` rows for `pr-merge-guard`
  and `codex-push-guard` updated the same way (Codex GitHub App P2 on PR #1069).
- Text only; no gate behaviour changes.
