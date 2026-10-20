## 2026-10-20 — Guard follow-ups from PR #956: clustered runtime flags, `deno eval`, GitHub writes under a hold

Three gaps found by Codex's GitHub reviewer on PR #956 and deferred from it. main allowed all
three; Mason chose these three and dropped the other six deferred spelling variants.

- **Clustered runtime flags.** `node -pe "…gh pr merge…"` (also `-ce`, `-ep`, `python -Bc`, `perl -0e`) was read
  as code `e`, so the real code argument was never judged and both the merge and push guards
  allowed it. A short-option cluster with a code letter anywhere in it now takes the next word as
  code too. `node -pe "1+1"` still passes.
- **`deno eval`.** Its code is a subcommand argument, not a flag, so `deno eval "new
  Deno.Command('gh',…)"` passed both guards. Every word after `deno eval` / `bun eval` is now judged, also when options come first
  (`deno --quiet eval`, `deno -L debug eval`): any `eval` word after `deno`/`bun` starts the code.
  The merge-guard-launcher fallback already counted `eval`; it now counts the wider clusters too.
- **GitHub MCP writes under a hold.** `create_pull_request`, `update_pull_request`,
  `add_issue_comment` and the rest of the write family went through a "stop". The hold latch now
  holds every `mcp__github__` tool except a read (`get_*`, `list_*`, `search_*`, `*_read`,
  `actions_get`, `actions_list`), so a new write tool is held by default. A `mark_*` tool is never
  a read, even ending in `_read` (`mark_all_notifications_read` changes state; CodeRabbit).

Tests: `pr-merge-guard.test.mjs`, `codex-push-lib.test.mjs`, `merge-guard-launcher.test.mjs`,
`guards.test.mjs` (both directions). Reference: `docs/reference/agent-guardrails.md`, Guard narrowing item 6.
