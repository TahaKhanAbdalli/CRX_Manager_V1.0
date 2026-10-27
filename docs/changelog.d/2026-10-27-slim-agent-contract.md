## 2026-10-27 - Slim the shared agent contract

- Compared `AGENTS.md` with the maintained `CLAUDE.md`; retained Claude's existing import and routing wrapper unchanged.
- Condensed repeated owner, authority, delivery, and completion wording. Kept task routes, all CRX Hard Rules, review requirements, approval boundaries, and the narrow guard-cleanup exception explicit.
- Routed review timing, retries, and proof carry-forward details to their existing canonical procedures. Clarified the supported Claude handoff when Codex cannot apply a live migration.
- Updated the owner playbook to explain shared guidance ownership and on-demand procedure loading. No hook, permission, model pin, database, or application behavior changes.
