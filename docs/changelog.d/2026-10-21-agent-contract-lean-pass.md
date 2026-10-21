## 2026-10-21 — Agent contract lean pass (AGENTS.md, CLAUDE.md)

- `AGENTS.md` CodeRabbit bullet now says what the merge gates actually enforce: after fixing or
  refuting each CodeRabbit and Codex GitHub App comment, reply on and resolve every thread, because
  both merge gates deny an open CodeRabbit thread, one resolved without a reply, or an open Codex
  App thread on the head (`.claude/commands/ship.md` Step 8 has the mechanics). The `docs(` title
  skip and the "never re-reviews" detail moved out; both remain in `ship.md`.
- `CLAUDE.md` drops three lines that repeated `AGENTS.md` (the Graphify when-to-use, the
  schema-registry search rule, and the `docs/manual/` summary, all already in the routing table or
  "Start and Route") and points schema-registry refreshes at `regen-schema-registry`.
- No rule was loosened; `npm run test:agent-workflows` passes.
