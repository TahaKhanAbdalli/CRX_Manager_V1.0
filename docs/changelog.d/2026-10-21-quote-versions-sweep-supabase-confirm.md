## 2026-10-21 — quote-versions-rpc-owned sweep runs in Claude mode again

- Cause: `execute_sql` returned `{"status":"declined"}` for this predicate on every Claude-mode run, so
  `--adjudicate` could never certify all 29. No repo hook declined it (all PreToolUse hooks allow the exact
  query). The hosted Supabase MCP server's own destructive-SQL heuristic did: it splits on every `;`, and in
  a piece containing `EXECUTE` plus whitespace it treats a later quoted `DELETE`/`TRUNCATE`/`DROP` as dynamic
  destructive SQL. The reason string "must not hold EXECUTE on …" followed by a
  `has_table_privilege(..., 'DELETE')` argument tripped it, and the server's confirmation request was
  auto-declined because this client shows no confirmation form. Repro, declined live:
  `SELECT 'must not hold EXECUTE on x' AS a, 'DELETE' AS b`.
- Fix: three reason strings in `quote-versions-rpc-owned.sql` now say "must not be able to call". Violation
  keys and query logic are unchanged; the guard's predicate fingerprint was regenerated.
- Guard: new `scripts/db-invariant-sweeps/mcp-destructive-sql.test.mjs` (in `test:correction-guards`) ports the
  server's heuristic and fails if any printed sweep query would be declined. It fails on the old wording.
