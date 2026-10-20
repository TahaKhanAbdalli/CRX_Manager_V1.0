## 2026-10-18 — Guards narrowed to what they protect

**Why.** An audit of which hooks block safe work, checked by an independent adversarial Opus review,
found five refusals that cost far more than they protected. Since 2026-10-03, the merge and push
gates refused ordinary inline scripts in about 86 sessions. The review proof guard denied any command
mentioning a `.claude` path next to a word like "rm" in 34 sessions. The hold latch froze whole
sessions on helper reports, twice more on 2026-10-18 alone. Mason approved the revised plan
("Yes revised plan").

**What changed.**
- `.claude/hooks/codex-push-lib.mjs`, `pr-merge-guard.mjs`, `codex-push-guard.mjs`: the run-time-text
  and fed-interpreter refusals run only when `couldReachGatedAction` finds a gated word, or
  obfuscation together with a way to run a program. Every readable merge, push and `--admin` check is
  unchanged.
- `.claude/hooks/hold-latch-lib.mjs`, `hold-latch-guard.mjs`: `holdDecision` returns deny, warn or
  allow. Outward actions deny. Push and merge are now read through autopilot's global-option-aware
  patterns, which closes the `gh pr merge … --match-head-commit` gap. The destructive local commands autopilot denies stay denied;
  ordinary local edits and commits warn.
- `.claude/hooks/review-proof-guard.mjs`: the `.claude` ancestor rule is narrowed to whole targets,
  keeping `.claude/worktrees` at full breadth. `.claude/agents` and `.claude/commands` are enforcement
  surfaces. `codex-push-lib.mjs` `reviewProofPathMentioned` now also protects `migration-review-*.json`,
  `owner-approval-*.json`, `AUTOPILOT.on`, `applied-migrations.json` and `hold.json`.
- `.claude/hooks/bash-safety-lib.mjs`: the retired maintenance-producer rule is removed.
- Tests updated in `guards.test.mjs`, `review-proof-guard.test.mjs`, `bash-safety.test.mjs`,
  `mcp-tool-guard.test.mjs`, `pr-merge-guard.test.mjs` and `merge-guard-launcher.test.mjs`. Docs
  updated in `docs/reference/agent-guardrails.md`, `docs/manual/DECISION_LOG.md` and
  `docs/manual/KNOWN_ISSUES.md`.

**Proof.** Every `.claude/hooks/*.test.mjs` suite passes. Ran against the real hooks:
- the merge and push gates allow 11 ordinary shapes and still deny every merge and push form tried,
  except the two file-payload forms, which now match `bash payload.sh`;
- the hold latch with a latched `hold.json` warns on an edit and a commit, and denies `gh pr merge`,
  `git -C … push` and `select public.void_invoice(42)`;
- the review proof guard passes the reviewer's over-block probes and denies every forgery probe.

**Luna round 1 (7 findings).** Fixed:
- inline scripts that join strings with `+` (`'g'+'h pr '+'mer'+'ge'`) now count as obfuscation;
- the review proof guard's home-folder exclusion is anchored to a real home folder;
- the hold latch treats `gh api --field/--raw-field/--input` and writing REST clients (curl,
  wget, Invoke-RestMethod/WebRequest with a write method or a body) as outward;
- the launcher parity test now requires the working guard to deny every gated form, with one
  listed exception that main also allowed.

Declined, with reasons:
- (MED) a computed, fed or inline-code command that only mentions `git`/`merge`/`push` (for example
  `node -e "console.log('git')"`), and any run-time-built program name, are still refused even
  though they may not reach a gated action. This is a deliberate over-refusal at the merge and
  push gates, named as such in the DECISION_LOG operative rule. Command text cannot tell which of
  these reach a merge, and the common harmless shapes show no such word.
- (MED) the bare `deploy` match under a hold is unchanged from before this PR and errs toward
  blocking only while a stop is latched.
- (superseded in round 2, see below) inline `node -e` code.

**Codex connector (2 P1) and Luna round 2 (8 findings).** Fixed:
- a program name assembled from shell variables in the same command (`a=g; b=h; … $a$b pr $c$d 951`)
  is refused outright (`programAssembledAtRuntime`). main allowed it too;
- inline code arguments (`node -e`, `python -c`, `perl -e`, `ruby -e`, `php -r`) are refused when the
  CODE itself could reach a gated action (`inlineCodeReachesGatedAction`). main allowed the base64
  `node -e` merge. `gh … | node -e "…"` still passes when the code shows nothing gated. The fallback
  launcher counts any inline-code launch as a possible merge;
- `.`/`..` segments below `.claude` (`find .claude/./ -delete`, `.claude/hooks/../session-state`)
  count as the whole folder or the state dir;
- the `~`/`$HOME` home exclusion is anchored to the start of a word;
- the hold latch treats `gh pr update-branch`, `gh workflow run`, `gh secret/variable set`, repo,
  release, issue, label and gist writes, `curl -T`/`--upload-file` and `wget --method=…` as outward.

Refuted with a probe: `cp /tmp/payload .claude/./hooks/…` was already denied, because
`namesEnforcementSurface` resolves dot segments.

Declined: a fed script whose text names `git` (intended speed bump), the
`ls .claude/session-state | grep del` over-block (pinned in the tests), and `vercel whoami`
under a hold (the `vercel\s` match is unchanged from before this PR).

**Luna round 3 (9 findings), last iterating round.** Fixed: `fromCodePoint`/`fromhex`/`unhexlify`/
`pack(`/`ord(` and a bare `join(` count as obfuscation; inline code attached to its short flag
(`perl -e'…'`) is read; and under a hold any `psql`/`pg_restore` launch is outward.

Declined: an assembled program name that cannot reach a gated action is still refused
(`P=python; $P --version`, which is rare); inline code that only prints a gated word; the bare `deploy`
match; the hold's deliberate `create_directory` deny (in the tool superset since 2026-07-13);
the pinned `ls … | grep del` over-block; and SQL keywords inside string literals under a hold.

**Mason, 2026-10-18: no more iterating Codex rounds** ("call it good if we are fixing little tiny
bugs"). Rounds 1–3 kept finding new spellings of one class: a merge hidden inside code that a
runtime executes. A text check cannot close that class, because `node file.mjs` running the same
code has always been allowed. It is recorded as a **speed bump**, not a boundary. Each spelling
found was added, and the remaining residual is stated here and in agent-guardrails.md.

**Codex connector on `1f43c9cd4` (3 P1).** Fixed: a `printf` format with a `%` directive counts as
obfuscation (`printf 'g%s pr m%s 951' h erge | bash`); a path below `.claude` built at run time
(`.claude/s$(printf ession-state)`, `.claude/$X`) counts as the state dir; and under a hold,
`gh <global options> api … -f` is outward.

**Codex connector on `4f51aa4fc` (2 P1).** Fixed: any top-level program name built at run time is
refused, including a plain command substitution (`$(printf g)h pr m$(printf er)ge 951`); and under
a hold, an attached short `gh api` field flag (`-fbody=x`) is outward.

**Codex connector on `68b78a17d` (3 P1), the last fixes before landing.** Fixed: backtick-built
program names are refused; inline-code detection scans past a detached option value
(`node --require fs -e …`); and under a hold, attached curl flags (`-dfoo`, `-Ffoo=bar`, `-Tfile`) are
outward. Mason: "After fixing those no more codex rounds we are finished make it live."

**CodeRabbit (7, CHANGES_REQUESTED on `10450759a`).** Fixed: `{` and `,` delimit a whole `.claude`
target (`rm -rf {.claude,}`, `Remove-Item .claude,x`); under a hold, backslash-newline continuations
are joined and `SELECT … INTO` is a write; the fallback launcher counts attached `-e'…'` code; the
new test loops use the entrypoint helpers; the decision log names the protected-file exception. Codex connector items on
`10450759a` (`-X=DELETE` under a hold; MCP path-field writes to `.claude/agents|commands`, which
still prompt through permissions.ask) are deferred to a follow-up.

**CodeRabbit on `2cbc992f6` (1).** Fixed: `SELECT … INTO` counts as a write across a `;` inside a
string literal (`SELECT ';' INTO t`).

**CodeRabbit on `df313fe26` (2).** Fixed: under a hold, curl `--form-string` and `--data-ascii`
are outward; the decision log names the merge/push gates' deliberate over-refusal. Also folded in
from the Codex connector: `.claude/skills` and `.claude/workflows` are enforcement surfaces
(shell deletes and writes are refused, reads pass).

**Sol on `824061121` (BLOCKERS), split.** Sol rated the permission change HIGH: with the Edit/Write
prompts on guard files removed, a session could edit a merge or push guard, act, and restore the
file before a PR diff shows it. Mason: "Split it." `.claude/settings.json` and
`scripts/check-agent-guidance.mjs` are restored to main, so every guard file keeps its prompt; the
prompt removal moves to its own PR for Mason to merge himself. Sol's MED (a hold warns, not denies,
on local edits) is the approved design and stays.

**Codex connector on `8cdd865dc` (1 P1, a regression).** Fixed: Bash extglob below `.claude`
(`bash -O extglob -c 'rm -rf .claude/s@(ession-)state'`, `+(…)`, `!(…)`) counts as a glob that may
expand to the state dir. main denied it; the narrowed matcher had missed it. The shared glob-segment
check now reads extglob too, so an obscured ancestor (`.clau@(de)`, `.c+(laude)/s@(ession-)state`,
`.clau!(x)/s*`) is denied; main allowed those.

**Codex connector and CodeRabbit on `a7f1a5077` / `21514d6e9` (2 regressions).** Fixed: a program
name glued from a substitution and letters INSIDE a computed nested command
(`bash -c '$(printf g)h pr m$(printf er)ge 951'`, the `git push` twin) is refused by both gates
(`nestedProgramNameGlued`); main refused these, the narrowed gates had missed them.
`eval "$(fnm env)"` and `$((i+1))` still pass. Brace expansion `{.claude/s@(ession-)state,x}` counts
as a path below `.claude`. The decision log now says unmatched actions are allowed, not warned.

**Codex connector and CodeRabbit on `eea1af79b` (2 regressions, 1 test tidy).** Fixed: a delete or
move after `cd` into the repo's `.claude` (`cd .claude/hooks && rm -f pr-merge-guard.mjs`, the
`commands`/`agents`/`skills`/`workflows` twins, `pushd`, `Set-Location`) is denied again; each
segment named no protected path, so the narrowed rule had missed what main denied. The cd target now
carries the protection across `&&`/`;`; reads after that cd and deletes after `cd src` still pass,
and the home `~/.claude` stays out. `nestedProgramNameGlued` reads balanced nested substitutions
(`bash -c '$(echo $(printf g))h pr m$(echo $(printf er))ge 951'`) through `splitSubstitutions`, so
both gates refuse it again. Three single-case checks in `review-proof-guard.test.mjs` use the
entrypoint helpers. CI: the sweep runner now waits for its ~300 KB print to flush before exiting;
one Linux run had read 21 of 29 blocks and a re-run of the same code passed.

**Codex connector on `1c89e107a` (1 regression).** Fixed: deleting, moving or overwriting
`.claude/schema-registry.json` by shell (`rm`, `mv`, `Remove-Item`, a `>` redirect) is denied again,
as main denied it. Without the registry three schema checks allow everything. Reads still pass.

**CodeRabbit and Codex connector on `9ef250cc5` (2 regressions, 1 tidy, 1 not a regression).**
Fixed: an unclosed `$(` that opens a nested program name (`bash -c '$(printf g h pr m$(printf
er)ge 951'`) is refused by both gates again, and an unreadable cd target (`D=.claude/hooks; cd $D
&& rm -f …`) counts as entering `.claude` when the command names the repo's `.claude`; main refused
both. The recorded cd targets reset on each evaluation. Not changed: a PowerShell backtick
continuation under a hold (main's hold latch allowed it too).

**Codex connector on `05b24f5f9` (1 regression).** Fixed: deleting, moving or overwriting
`.claude/caller-graph.json` (grant-change-guard's input) is denied again. The by-name rule now
covers every guard input directly in the repo's `.claude` folder (schema registry, caller graph,
active areas), checked against every hook that reads one, instead of one name per review round.

**Takes effect** only after `C:/CRX_Manager` is fast-forwarded past the merge, because worktree
sessions load hooks and settings from the main checkout.
