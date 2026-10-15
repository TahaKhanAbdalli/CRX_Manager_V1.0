## 2026-10-15 — Vercel and Supabase permission rules use the connectors' real tool names

Found in a harness review Mason asked for (2026-10-15); Mason approved the permission change in that
conversation.

- **Vercel rules matched nothing.** About 90 allow/ask/deny rules in `.claude/settings.json` were
  spelled `mcp__Vercel__…`. Every Vercel call in every saved session uses the connector's real name,
  `mcp__0fb370f6-ff90-41a7-8c20-6f1490a21d59__…`, so production promote, rollback, create-deployment,
  domain purchase and env edits were never denied by them. Checked live on 2026-10-15: a
  `cancel_deployment` call with a made-up ID went straight through to Vercel (404) under the old rules.
  The rules are now spelled with the real name. The duplicate `ask` copy of `deploy_to_vercel` was
  dropped because the `deny` copy wins anyway.
- **Supabase.** The `mcp__Supabase__…` (capital S) rules also matched nothing. The three with no
  correct-name twin (`list_edge_functions`, `get_project`, `get_edge_function`) are re-spelled with
  the claude.ai connector's real name (`mcp__50e15046-…`) and the rest removed as duplicates. Secret
  creation, project pause/restore/create and branch create/delete/merge/rebase/reset now ask first
  on both Supabase connections (the lower-case set was completed after Luna review round 2).
- **Not changed here.** `execute_sql` on the claude.ai Supabase connector stays a deliberate allow
  rule; the email `send_message` gap stays open in `docs/manual/KNOWN_ISSUES.md`.
- **Split out.** This PR first also carried a hold-latch fix for helper-agent reports; Sol blocked it,
  so it was removed and is recorded as its own open issue in `docs/manual/KNOWN_ISSUES.md`.
- Mason's personal `autoCompactWindow` was set to 800,000 (it was 1,000,000, at the 1M ceiling,
  against his own global rule). That is a user setting, outside the repo.
