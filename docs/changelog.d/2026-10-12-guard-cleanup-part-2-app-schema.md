## 2026-10-12 — guard cleanup, part 2: read-named functions are vouched for only in `public`

Follows `2026-10-11-guard-cleanup-part-2-review-round.md`. `main` (#888) was merged into the branch first; the only conflicts were `package.json` (both test lists kept, plus `sol-exempt-lib.test.mjs`) and `autopilot-intent-reminder.mjs` (deleted here, one wording line changed on `main`; deleted, by Mason's own `git rm`, since agents cannot delete under `.claude/`).

**Fixed (Luna, HIGH, on the merge commit 7a27e3d9a)**

- `live-testdata-lib.mjs`: the `get_`/`list_`/… prefix rule and `READONLY_FN_NAMES` still accepted a call in any schema, so `SELECT evil.get_invoice(42)` passed as a read. They now apply only to an unqualified or exactly-`public` name; `"PUBLIC".get_x()`, `"GET_X"()` and `x$public.get_x()` are other objects. With this, every exemption in `findNonReadFunctionCall` checks the schema: built-ins and keywords (`pg_catalog`), `uid` (`auth`), the `pg_stat`/`pg_ls` prefixes (`pg_catalog`) and the application read names (`public`). `main` has the same schema-blind prefix rule; this closes it rather than leaving the last exemption unscoped.

**Accepted (Luna, LOW, already recorded):** the quoted-literal false alarm in the shell reader and `extensions.uuid_generate_v4()` being refused.

**Proof observed**

- `npm run test:correction-guards` exits 0 (`guards` 201 assertions); `evil.get_invoice(42)` and the three lookalikes are blocked; `get_invoice(42)`, `public.get_invoice(42)`, `"public".get_invoice(42)` and `PUBLIC.list_orders(1)` are still reads, as are the ordinary catalog and invoice queries in the earlier probes.
