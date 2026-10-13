## 2026-10-11 — guard cleanup, part 2: CodeRabbit and Codex connector on 261fbac57

Follows `2026-10-10-guard-cleanup-part-2-luna-dollar.md`.

**Fixed**

- CodeRabbit (Minor): the depth-limit rule counted an arithmetic `$(( … ))` as an unread substitution, so `x=$(y=$(z=$(w=$(echo $(( 1 + 2 )))))); git status` was refused (as it also is on `main`). At the limit, only a command substitution, a backtick or an unclosed `$(` counts now; arithmetic does not.
- Codex connector (P2): a SQL comment between a schema and a function name (`evil./*x*/pg_get_triggerdef(1)`) hid the schema, and one before the parenthesis (`cancel_order/**/(42)`) hid the call. `findNonReadFunctionCall` now removes comments first with the existing quote-aware `stripCommentsQuoteAware` (each comment becomes one space; `--` or `/*` inside a string or quoted identifier stays data). Comment prose such as `-- cancel_order(42)` is no longer read as a call.

**Declined with reason**

- Codex connector (P2): `printf '%s' '$($P pr merge 1 --admin)'` is refused although the single quotes make it inert. This is the false alarm already accepted in `2026-10-10-guard-cleanup-part-2-coderabbit.md`: reading quotes the way the shell does was tried twice on this PR and dropped because shells disagree on where quotes end and the blanking hid real programs. Refusing a literal that spells a computed merge is the safe direction.

**Proof observed**

- The real merge and push hooks, run from `main`, from 261fbac57 and from this commit: the nested-arithmetic `git status` goes from deny to allow; the backtick and `$( … )` merges at the depth limit, and every earlier refused shape, stay denied; the read-only `while read` loop stays allowed.
- `npm run test:correction-guards` exits 0 (`guards` 199, `pr-merge-guard` 256, `predicate-fingerprints` 526 assertions).
