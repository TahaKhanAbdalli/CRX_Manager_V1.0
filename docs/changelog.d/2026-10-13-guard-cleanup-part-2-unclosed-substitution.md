## 2026-10-13 — guard cleanup, part 2: an unclosed `$(` no longer hides a later one

Follows `2026-10-12-guard-cleanup-part-2-identifier-chars.md`.

**Fixed (CodeRabbit, Major, on 3d0130285)**

- `codex-push-lib.mjs`, `splitSubstitutions`: a quoted `'$('` opened a quote that never closed, so the splitter gave up there and a real `$($P pr merge 1 --admin)` AFTER it was read as plain words, where the `x=$($P` assignment is skipped. `P=gh; echo '$('; x=$($P pr merge 1 --admin)` passed both the merge and push guards (it passes on `main` too, as does the reverse order this PR already closed). The text after an unclosed `$(` is now returned as `unclosed` and checked like any other substitution, so a run-time program anywhere in it is found.

**Not taken: CodeRabbit's suggested fix**

- It refused every command with an unclosed `$(`. The reader does not know heredocs, so the everyday `git commit -m "$(cat <<'EOF' … EOF )"` and `gh pr create --body "$(cat <<'EOF' … )"` read as unclosed whenever the message holds an apostrophe ("don't", "it's"), and both would have been refused — a new false alarm on nearly every agent commit. Checking the unclosed tail instead refuses the hidden merge and keeps those messages.

**Refuted (Luna, MED, review of this fix)**

- Luna: a heredoc commit message that quotes a hidden-merge example as literal text after an apostrophe (`Don't include this example: $(P=gh; $P pr merge 1 --admin)`) is now refused. Measured through the real hooks, it is refused on 3d0130285 and on `main` too, and so are the same message without the apostrophe and with the example not wrapped in `$( )`: the reader has never understood heredoc quoting, and this commit does not change that. `git commit -F <file>` passes.

**Proof observed**

- The real `pr-merge-guard.mjs` and `codex-push-guard.mjs`, from this head: seven hidden merge or push shapes deny — (1) a quoted `'$('` before a merge, (2) a quoted `'$('` before a force-push to `main`, (3) a double-quoted `"$("` before a merge, (4) a quoted `'$('` after a merge, (5) a heredoc with a lone `'` inside the merge's own substitution, (6) a heredoc commit message holding an apostrophe before a merge, and (7) a four-deep nested merge after a quoted `'$('`; from 3d0130285 all but (4) were allowed. Six of them are asserted in `codex-push-lib.test.mjs` ((4) was already asserted there), and (1) also through the real hook in `pr-merge-guard.test.mjs`. Heredoc commit and PR messages with apostrophes, `echo '$('`, the read loop, `i=$(($i+1)); git status`, `x=$(git rev-parse HEAD)` and `git status; echo '$('` all still pass.
- New assertions in `codex-push-lib.test.mjs` and `pr-merge-guard.test.mjs` fail with the new check switched off and pass with it on; `npm run test:correction-guards`, `npm run test:agent-workflows` and `npm run agent-health` exit 0.
