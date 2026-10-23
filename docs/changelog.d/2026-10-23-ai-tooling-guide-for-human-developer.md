## 2026-10-23 — AI tooling guide for the incoming senior developer (Goal 9)

Added `docs/manual/AI_TOOLING_GUIDE.md`, the "AI tooling guide" Goal 9 asks for. It explains, for a
human developer, what the Claude and Codex hooks, review scripts and merge gates do (grouped), which
tools are optional and which gates are mandatory, how a human completes the delivery path in
`.claude/commands/ship.md`, how to clear a stuck gate, and how to ask for a reviewed policy change.

It also answers, from the code, whether a human without Claude Code or the Codex CLI can merge. The
Sol proof is written only by `scripts/write-codex-push-proof.mjs` into the git-ignored
`.claude/session-state/` folder and is read only by the local agent hooks (`pr-merge-guard.mjs`,
`.codex/hooks/production-action-guard.mjs`). GitHub's `protect-main` ruleset requires only a pull
request and three checks (`Lint, Type Check, Test, Build`, `SQL Migration Validation`, `Vercel`), with
no approvals and no Sol check. So a human can press Merge on GitHub and skip the Sol review and the
other merge-time rules, and cannot produce a Sol proof without the Codex CLI. The guide records a
proposal (not built) to publish the Sol proof as a commit status and make a CI job that checks it a
required check, so GitHub enforces the Sol review for everyone. No gate was changed.

Placed in `docs/manual/` rather than `docs/reference/` so it stays a documentation-only change; it
describes the tooling and defers to `AGENTS.md` and `ship.md` for the rules.
