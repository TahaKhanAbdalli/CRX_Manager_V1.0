## 2026-10-25 — Live smoke runs work again: the live-data guard allows rollback-only batches

**What broke.** After #1084 (2026-10-25) the live-data guard refused 65 of the 69 live-runnable
`scripts/smoke/` chains, so the post-apply live smoke step could not run for any migration (reported by
the #1058 session through the coordinator). Before #1084 those chains also failed the rules on their
own; they ran only because any leftover `REAL-DATA-OK` marker switched every rule off, and #1084 made
the marker stop unlocking RPC calls.

**Fix.** `isVerifiedRollbackBatch()` in `.claude/hooks/live-testdata-lib.mjs` recognises a batch that
PostgreSQL must undo entirely: `BEGIN` first and `ROLLBACK` last with no other transaction control, or a
final `DO` block that always ends in `RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK…'` (no RETURN, COMMIT,
ROLLBACK or CALL that could skip or split it, no EXCEPTION section and no label on the outermost block,
and only a leading `BEGIN`, temp-object setup, or other DO blocks free of transaction control before
it; PostgreSQL runs one multi-statement query string as one implicit transaction). The outer-handler rule came from the
automated security review: a raise that sits only in the outer handler runs only when something else
failed. Such a batch may call RPCs, write fixtures and touch the audit log, since none of it persists.
TRUNCATE and direct `setval`/`nextval` stay refused. A sequence advanced INSIDE a called RPC is not
undone by the rollback: that leaves a numbering gap, the same as the smoke runs did before #1084, and is
accepted. Anything else a rollback does not undo disqualifies the batch: dblink, pg_background, http or
pg_net calls, session advisory locks and unlocks, signalling other backends, non-transactional logical
messages and replication slots, server-side file reads/writes and COPY to or from a program or file, and
CREATE EXTENSION / SERVER / FOREIGN DATA WRAPPER / USER MAPPING (on 2026-10-25 none of the remote-call
extensions were installed live). String literals, quoted identifiers, comments and nested function
bodies are walked in one pass, so they cannot fake or hide any of this.

**Holes closed on the way (reported by the #1093 session and Luna).** The older textual "rolled back"
test, which exempted DDL, accepted `BEGIN; <DDL>; END; … ROLLBACK;`, and END is COMMIT; that exemption
now uses the same verified check. RPC calls inside a DO body (`PERFORM save_x()`, `v := save_x()`) or a
`CALL proc()` were never scanned, because the scanner required the word SELECT; outside a verified
rollback batch they are now refused. TRUNCATE inside a DO body is refused (it was only caught at the
start of a statement, and now also in a literal `EXECUTE 'TRUNCATE …'`), and COPY to or from a server
program or file (including `E'…'` names) is refused everywhere. Calls whose effect no rollback undoes
(remote calls, session locks, signalling backends, statistics resets, server file I/O) are refused
everywhere too, and function names are checked with comments and double quotes removed, so
`pg_catalog."setval"(` or `setval/**/(` cannot slip past (Codex App). Temp functions in a native or
untrusted language (C, internal, plpython…) disqualify a batch. Real live
writes outside such a batch are otherwise unchanged.

**Proof.** 66 of the 69 live-runnable smoke chains classify as allowed (before: 65 refused), with or
without a marker; the other three are the dynamic-SQL chains above; more than 30 attack shapes (conditional or swallowed raise, a raise only in the outer handler, a labeled
outer block left with EXIT, early RETURN, COMMIT/END mid-batch, CALL, dblink, a write before the DO
block, a raise only in a string or comment, quote and `$tag$` tricks, END or COMMIT AND CHAIN before
ROLLBACK, a variable or quoted identifier named raise/end, CREATE EXTENSION plus dynamic SQL, session
advisory locks) are refused, and RPC calls via PERFORM, assignment or CALL are refused outside such a
batch. Eight dynamic-SQL shapes that c52cc3ce5 accepted as rolled back (Sol's `||` case, `format('%s')`,
`E'\x76'`, a commented literal, a nested DO, a pg_temp function running its parameter, `query_to_xml`, a
reassigned loop variable) are refused now.

**Dynamic SQL (Sol, BLOCKERS on c52cc3ce5).** A text check cannot read SQL assembled at run time, so
`DO $$ BEGIN EXECUTE 'SELECT set' || 'val(…)'; RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK'; END $$` used to
pass as rolled back while it reset a live sequence. In a rollback-only batch every `EXECUTE` (in DO bodies,
supplied function bodies and executed text alike) must now run ONE literal the name checks already read: a
dollar-quoted string, or a plain `'…'` with no backslash and no comment opener, followed only by the
statement's end, `INTO` or `USING`. Anything else disqualifies the batch: a variable, `||`, `format()`,
`E'…'`, and `query_to_xml`/`ts_stat`/`ts_rewrite`, which also run text. This closes the whole class
rather than one spelling (the coordinator's call, 2026-10-25). Three chains run a loop variable over
`format()` text and are refused until rewritten to `EXECUTE '<literal>' USING …` (follow-up):
`cost_margin_admin_only_rpc_leaks`, `money_replay_binding_batch1` and the local-only
`save_quote_customer_row_version`. Luna's second round on the fix added: executed literal text gets the
COPY-to-program check too; `LOAD`, `PREPARE` (a prepared statement outlives the rollback in the session)
and function bodies in any language but `sql`/`plpgsql` (plperl's `spi_exec_query` runs SQL without
EXECUTE) disqualify a batch; and server-admin calls (`pg_log_backend_memory_contexts`, log rotation,
restore points, WAL switch, promote, backup and WAL-replay controls) are refused everywhere. Sol's second
review (5f2e2ccb0) found `BEGIN; SELECT pg_read_file(…); ROLLBACK;` and `pg_file_unlink` accepted as rolled
back: a rollback neither unreads a returned file nor restores a deleted one. Server-file functions are now
matched as a family (`pg_read_*`, `pg_file_*`, `pg_ls_*`, `pg_stat_file`, `pg_logdir_ls`,
`pg_current_logfile`), with every `pg_log_*` and `http`/`http_*` call, and refused everywhere; `CHECKPOINT`
disqualifies a batch. The Codex App (d5ab5782d) found `CREATE OPERATOR === (…, FUNCTION = setval)` followed
by `x OPERATOR(===) 1` accepted as rolled back: an operator names its function without `(`, so the name
checks never saw `setval`. Creating or altering any object that binds a function by name (operator,
aggregate, type, cast, conversion, text search object, access method, language, transform, event trigger)
now disqualifies a batch, wherever it appears; no live smoke chain defines one. The Codex App (ad4206786)
then found `PERFORM 1 AS case; EXCEPTION WHEN OTHERS THEN PERFORM 1 AS end;` accepted: the output aliases
paired as a CASE … END across statements and hid the outer handler. A CASE expression must now close in
its own statement, and a CASE statement (at a statement start or after BEGIN/THEN/ELSE/LOOP/DECLARE) only
with `END CASE`; anything else is ambiguous and refused.

**Residual risk, accepted.** "Rolled back" means every table write is undone. The guard reads only the
submitted text, never the bodies of functions already in the database, so whatever a called RPC or
trigger does outside the transaction is not seen. On 2026-10-25 that is a sequence advanced inside a
called RPC or by a column default (`INSERT … DEFAULT VALUES` on a serial table), which keeps its numbering
gap (see above); none of the remote-call extensions are installed live. Dollar-quoted text nested more
than 16 deep is refused rather than scanned (Luna).
