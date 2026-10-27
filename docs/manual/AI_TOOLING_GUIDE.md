# AI tooling guide for a human developer

Written 2026-10-23 for the senior developer taking over CRX Manager (Goal 9 of
`docs/plans/2026-10-13-direction-and-goals.md`). Mason decided on 2026-10-13 that all AI tooling
stays in the repository at handoff and is documented here.

This page describes the tooling. It does not set rules. The rules are in `AGENTS.md` (the shared
contract every agent loads), `.claude/commands/ship.md` (the delivery path) and the code of the
hooks themselves. If this page and those disagree, they win; please fix this page.

## The short version

- CRX Manager is built mostly by AI coding agents: **Claude Code** (Anthropic) and the **Codex
  CLI** (OpenAI). Both run on Mason's Windows PC, in many parallel sessions, each in its own git
  worktree.
- The repository carries a large safety layer for those agents: **hooks** (small Node scripts the
  agent runtime runs before or after each tool call), **review gates** (scripts that run a second
  AI model as a reviewer and write a "proof" file when it comes back clean), and **GitHub-side
  checks** (CI and branch protection).
- Only the GitHub-side checks bind a person who does not use the agents. Everything else runs
  inside Claude Code or Codex on the machine where the agent works.
- **Can a human merge without Claude Code or Codex? Technically yes, and that is the problem.**
  GitHub enforces only: a pull request is required, three status checks must pass, and nobody can
  force-push or delete `main`. The rule that every non-documentation merge needs a clean final
  **Sol** review (OpenAI's `gpt-6-sol` model, run through the Codex CLI) is enforced only by local
  agent hooks. A human clicking **Merge** on GitHub skips it, and so do the other merge-time rules
  below. The section "Can a human merge?" traces this, and the proposal at the end describes the
  smallest change that would make GitHub enforce it for everyone.

## Words used on this page

| Word | Meaning |
|---|---|
| Hook | A script Claude Code or Codex runs automatically at a fixed moment: before a tool call (PreToolUse, can refuse it), after one (PostToolUse), when Mason sends a message (UserPromptSubmit), at session start or at the end of a turn (Stop). Wired in `.claude/settings.json`; Codex runs the same scripts through `.codex/hooks.json` and an adapter. |
| Gate | Any check that can refuse an action: a hook, a CI job, or a GitHub branch rule. |
| Proof | A small JSON file in `.claude/session-state/` (git-ignored, so it exists only on the machine that made it) saying a reviewer ran on an exact commit and came back clean. Agents cannot write these by hand; a hook refuses any command that names one. Only the wrapper scripts mint them. |
| Luna | `gpt-6-luna`, the Codex model used for repeated review rounds while the change is being fixed. |
| Sol | `gpt-6-sol` at high effort, the single final review that must run last, on the exact commit that will merge. |
| CodeRabbit | A GitHub review bot. Advisory since 2026-10-19 and silent unless asked since 2026-10-21; required (as a clean review) only on PRs that touch money, invoices, payments, inventory or costs, or that Mason names. |
| Codex GitHub App | A second GitHub review bot (`chatgpt-codex-connector`). It reviews when a draft PR is marked ready. |
| Sol-exempt | A PR whose every file is plain documentation in an eligible folder. It may merge without the Sol review. Defined in `docs/reference/sol-exempt-paths.md` and `.claude/hooks/sol-exempt-lib.mjs`. |

## What runs where

| Layer | Where it runs | Who it binds |
|---|---|---|
| GitHub ruleset `protect-main` | GitHub | Everyone, including admins (no bypass list) |
| CI (`.github/workflows/ci.yml`) | GitHub Actions | Everyone; three results are required to merge |
| Vercel preview build | Vercel, reported to GitHub | Everyone; required to merge |
| Husky git hooks (`.husky/`) | Your machine, on `git commit` and `git push` | Anyone who ran `npm install` and does not pass `--no-verify` |
| Claude Code hooks (`.claude/hooks/`) | Inside Claude Code | Claude sessions only |
| Codex hooks (`.codex/hooks/`) | Inside the Codex CLI or app | Codex sessions only |
| Proof wrappers (`scripts/write-*.mjs`) | Your machine; need the Codex CLI | Read only by the agent hooks above |

### What GitHub actually enforces (read 2026-10-23)

From `gh api repos/masonwells1/CRX_Manager_V1.0/rulesets/18904218` and the older branch protection
on `main`. When the two differ, the stricter one wins.

- Changes reach `main` only through a pull request. Required approving reviews: **0**.
- Required checks: **`Lint, Type Check, Test, Build`**, **`SQL Migration Validation`** (both from
  `ci.yml`) and **`Vercel`**. The older branch protection also requires its checks to be on an
  up-to-date branch.
- No force pushes, no deleting `main`, a stale approval is dismissed when new commits arrive.
- Bypass list: empty. Conversation resolution: not required.

Nothing on GitHub reads a Sol proof, a CodeRabbit review, the Codex App's threads, or whether a
migration was applied to the live database before its code merged.

## The hooks, grouped

The full table, with every incident that produced each hook, is
`docs/reference/agent-guardrails.md`. You do not need to read it to work on the app. Here is what
the groups do.

**1. Code-pattern guards (before an agent writes a file).** `sql-safety`, `money-safety`,
`idempotency-body-check`, `actor-binding-check`, `rls-on-new-tables`, `status-enum-check`,
`generated-column-check`, `grant-change-guard`, `env-guard`. Each refuses a write that repeats a
known bug: floating-point parsing of cent amounts, a new table without Row Level Security, a status
value the database's CHECK constraint does not allow, writing a generated column, a mutating
database function whose idempotency key is not really used, a function that trusts a caller-supplied
"acting user", removing a grant that live code still calls, or touching `.env` files and keys.
Several read `.claude/schema-registry.json`, a snapshot of the live schema. For a human these
are the same rules as `docs/reference/coding-guidelines.md` and `docs/workflows/SAFE_DEVELOPMENT_RULES.md`;
the CI job `SQL Migration Validation` and `scripts/check-migration-hard-rules.mjs` check some of
them on GitHub too.

**2. Command safety (before an agent runs a shell or tool command).** `bash-safety`,
`mcp-tool-guard`, `active-area-guard`, `live-testdata-guard`. They refuse force pushes,
`git reset --hard`, discarding all changes, `--no-verify`, broad deletes, live-database writes
outside the approved doors, and test data written into production.

**3. Delivery gates (push, merge and live apply).** These are the ones that matter for shipping.
- `pr-merge-guard` (run through `merge-guard-launcher`, which denies if the guard crashes) checks
  every `gh pr merge` or merge API call. It allows a merge into `main` only when the newest run of
  every check is green, GitHub says the PR is mergeable, no review asks for changes, every
  CodeRabbit thread has a reply and is resolved, no Codex App thread is open on the head, a money
  PR has a completed CodeRabbit review (unless Mason waived it with `skip coderabbit #<PR>`), the
  command pins `--match-head-commit <sha>`, and a fresh Sol proof matches that head and GitHub's
  real base. A Sol-exempt PR skips only the Sol proof. `--auto` and `--admin` are refused.
- `codex-push-guard` checks pushes; `review-proof-guard` stops anyone writing a proof file by hand.
- `migration-apply-guard` (with `scripts/apply-migration-file.mjs`, its second door) applies a
  migration to the live database only with fresh reviewer proofs, a fresh content-bound Sol proof,
  the PR's head green and Sol-reviewed, and nothing destructive. Deleting rows, dropping data,
  overwriting rows or widening access additionally needs Mason's own `I approve` reply, recorded by
  `owner-approval-prompt` through `scripts/owner-approve-migration.mjs`.
- `.codex/hooks/production-action-guard.mjs` is the Codex twin of all of the above in one file.

**4. Owner-control hooks (Mason's messages).** `prompt-router` runs `hold-latch-prompt` (when
Mason says stop, pause or hold, outward actions such as push and merge are blocked until his next
message), `owner-approval-prompt` (records his `I approve` for a parked migration),
`coderabbit-skip-prompt` (records `skip coderabbit #<PR>`) and `ship-intent-reminder`.
`unattended-autopilot` auto-approves routine calls overnight, only when Mason arms it.

**5. Session housekeeping.** At start: `session-staleness` (schema snapshot behind migrations,
missing backup), `worktree-awareness` (other sessions working), `worktree-cleanup` (removes finished
worktrees), `session-snapshot`, `session-heartbeat`, `session-context-reminder`. At the end of a turn:
`stop-verify` (refuses "done" until the change was actually run and observed) and `stop-wrap`
(uncommitted files, unapplied migrations, undeployed functions). After a tool call:
`posttool-router`, `eslint-autofix`, `registry-freshness`, `applied-snapshot-invalidate`.

Files ending in `-lib.mjs` hold the shared logic; files ending in `.test.mjs` are their tests and run
in CI (`Guard, Packet, and Contract Regression Tests`, Linux and Windows).

## The review scripts

| Script | What it does | Needs |
|---|---|---|
| `scripts/write-codex-push-proof.mjs` | Runs one read-only Sol review of `origin/main...HEAD` from a clean, committed checkout and writes `.claude/session-state/codex-review-<head>.json` only if Codex ends with `CODEX_PROOF_VERDICT: CLEAN`. `--carry-forward` reuses a clean review after a plain merge of a newer `main` (rules in `.claude/skills/codex-review/SKILL.md`, Step 3B). A clean proof lasts 24 hours on an unchanged head and base. | The Codex CLI at its standard install location, signed in to an OpenAI account that can use `gpt-6-sol` |
| `scripts/write-apply-proofs.mjs` | Runs the reviewer charters and Sol on one migration file and writes the content-bound apply proofs (valid 30 minutes). | Codex CLI |
| `scripts/apply-migration-file.mjs` | Applies one migration file to live through the same rule book as the hook. Dry run without `--confirm`. | The proofs above and a Supabase access token |
| `scripts/owner-approve-migration.mjs` | Builds Mason's approval request for a destructive, overwriting or access-changing migration. | A Claude session where Mason replies |
| `scripts/run-claude-review.mjs` | Claude's reviewer for Codex-built work (the mirror of the Codex review). | Claude Code |

The Luna review rounds (`/codex-review`) and the Claude subagent reviewers (`.claude/agents/`) are
review aids. They mint no proof the merge gate reads.

## Optional and mandatory

**Optional for you (aids, not gates):** Graphify (`graphify-out/`, a code map), the Claude
subagents, `/preflight`, `/audit`, the Luna rounds, the fleet and status reports, autopilot, the
schema registry refresh, the daily landing summary workflow.

**Mandatory for every merge into `main`** (`AGENTS.md`, "Safety and Protected Delivery"):
1. A pull request, opened as a draft, marked ready once its head is final.
2. Every required check green on that head.
3. CodeRabbit and Codex App comments fixed or answered, each thread replied to and resolved. A
   money PR also needs a clean CodeRabbit review of its current head; narrow fixes for a review
   whose findings were all Minor or Trivial keep that review (Mason, 2026-10-26).
4. A fresh Sol review of the exact head, run last, unless the PR is Sol-exempt.
5. A migration, if any, applied live before the merge, through the gate.
6. Merge with `gh pr merge <n> --squash --delete-branch --match-head-commit <sha>`.

GitHub enforces items 1 and 2. Items 3 to 6 are enforced only by the agent hooks.

**Always Mason's call, in the current conversation:** destructive migrations, Edge Function
deploys, deleting data, force-pushing, and changes to secrets, authentication, permissions, billing,
domains or ownership.

## Working alongside the agents

- **Use a worktree, never the main checkout.** Mason's PC has many sessions running, each in a
  worktree under `C:/CRX_Manager/.claude/worktrees/` or `C:/CRX_*`. Create your own
  (`git worktree add ../CRX_<you>-<topic> -b <you>/<topic> origin/main`) or work on your own clone.
- **Do not delete, reset or force-push someone else's branch or worktree.** An agent may own it.
  `node scripts/fleet-status.mjs` (or asking an agent for `/fleet`) lists who is working where.
- **Never stage `.claude/session-state/`, `.codex/session-state/` or `.agents/skills/source-command-*`.**
  These are per-machine state and harness output.
- **Changelog:** every change adds its own `docs/changelog.d/<YYYY-MM-DD>-<slug>.md`. A commit that
  touches agent tooling or adds a migration is refused by the pre-commit hook without one.
- **Migrations:** new files only, never edit an applied one; Row Level Security and policies in the
  same file for a new table; mutating functions take `p_idempotency_key text DEFAULT NULL`.
  `docs/workflows/DATABASE_CHANGE_CHECKLIST.md` is the full list.
- **Agent sessions react to text.** The word "stop", "pause" or "hold" in a message to a running
  session latches a hold that blocks its pushes and merges until Mason writes again.
- **You can hand work to an agent.** Asking a Claude session to "ship" your branch runs the whole
  path in `.claude/commands/ship.md`, including the Sol pass and the merge, from Mason's machine.

## The protected delivery path, done by a human

Today's working answer, until the proposal below exists: **you build and open the PR; the Sol pass
and the merge run where the Codex CLI and the gates are.** Two ways to do that:

- **A. You install the tools** (Claude Code and the Codex CLI, with your own accounts). Then you run
  the same path the agents do and the gates check you. This is the closest to today's process.
- **B. You hand the final steps to an agent session on Mason's machine.** You do steps 1 to 4; a
  Claude session does 5 to 7.

Step by step:

1. **Branch from current `main`.** `git fetch origin && git switch -c <you>/<topic> origin/main`.
2. **Build and check locally.** `npm run typecheck`, `npm run lint`, `npm run build`, `npm run test`,
   and `npm run test:agent-workflows` if you touched agent files. Then run the change for real
   (`docs/manual/AGENT_ONBOARDING.md` and the "Done means ran and observed" rule in `AGENTS.md`).
3. **Open a draft PR** with a changelog entry. `gh pr create --draft`. Wait for the three required
   checks. Ask for Luna rounds if you want an extra review before freezing; they are optional for
   you.
4. **Freeze and mark ready.** Push your last fix, then `gh pr ready <n>`. The Codex GitHub App
   reviews now. On a money PR, request one CodeRabbit review: `gh pr comment <n> --body "@coderabbitai full review"`.
   Fix or answer every comment in one push, reply on each thread, and resolve it.
5. **Sol, last.** On a clean checkout of the exact head: `git fetch origin`, then
   `node scripts/write-codex-push-proof.mjs`. If `main` moves afterwards, merge it in with no other
   edits, push, wait for checks, and run `node scripts/write-codex-push-proof.mjs --carry-forward`.
   Skip this step for a Sol-exempt PR.
6. **Migration, if any.** `node scripts/write-apply-proofs.mjs <name>`, then
   `node scripts/apply-migration-file.mjs supabase/migrations/<file>.sql` (dry run) and again with
   `--confirm`. Before the merge, never after: merged code that calls a function the database does
   not have yet breaks production (this happened with PR #965 on 2026-10-20).
7. **Merge, pinned.** `gh pr merge <n> --squash --delete-branch --match-head-commit <sha>` from a
   Claude or Codex session, so the merge gate checks it. Merging deploys to croprxsolutions.app
   through Vercel; check the deploy. If you applied a migration, comment `Applied live: <name>`
   on the merged PR.

## Can a human merge without Claude Code or Codex?

Traced from the code on 2026-10-23 (`main` at `f52fbea6b`).

1. **What produces the Sol proof.** Only `scripts/write-codex-push-proof.mjs`. It runs the real
   Codex CLI from its fixed install path (on Windows `%LOCALAPPDATA%/OpenAI/Codex/bin`, with an
   npm-installed fallback; on Linux or macOS `~/.local/share/OpenAI/Codex/bin`; never from `PATH`), pins the model to
   `gpt-6-sol`, and writes `.claude/session-state/codex-review-<head>.json` only on a clean verdict.
   That folder is git-ignored. The proof never leaves the machine and is never sent to GitHub.
2. **What reads it.** Only `.claude/hooks/pr-merge-guard.mjs` (Claude Code) and
   `.codex/hooks/production-action-guard.mjs` (Codex), and they search only that machine's
   worktrees (`proofSearchDirs` in `.claude/hooks/codex-push-lib.mjs`). Both run before a tool call
   inside the agent. Neither runs in GitHub Actions, in a git hook, or on the GitHub website.
   Both files say so: "an honest-mistake net, not a security boundary".
3. **What GitHub requires.** The three checks listed above and a PR. No approving review. No Sol
   status. No bypass actor, so nobody can skip the three checks.
4. **The documentation exemption** is decided by the same local hooks reading GitHub's file list.
   GitHub itself treats a docs PR and a code PR the same.

**So:** a developer with write access and no agent tooling can open a PR, wait for the three green
checks and press **Merge** on GitHub, or run `gh pr merge` in a plain terminal. GitHub will allow it.
What it skips without any warning: the Sol review, the money-PR CodeRabbit review, the
review-thread rules, the `--match-head-commit` pin, and the "migration applied first" order. The
same is true for Mason clicking Merge, which he has done on purpose for PRs the agents' gate
refused, such as #1038.

And the other half: **without the Codex CLI the developer cannot produce a Sol proof at all**, and
without the gate's proofs cannot apply a migration through the sanctioned script. They can still
run SQL in the Supabase dashboard if Mason gives them a database login; no gate covers that.

So a human can merge, but only by stepping outside the process `AGENTS.md` says is mandatory.
There is no checked path for a human today except installing the agent tools (option A above).

## Proposal: let GitHub check the Sol review

**Not built.** This is for review; changing it needs a PR through the full path, a Sol review
(it touches `.claude/` and `.github/`), and Mason's approval for the ruleset change.

**The smallest change that gives a human a checked path and weakens nothing:**

1. **Publish the proof.** When `scripts/write-codex-push-proof.mjs` mints a clean proof (including
   `--carry-forward`), it also sets a GitHub commit status on that head, for example context
   `crx/sol-review`, state `success`, with the reviewed base SHA in its description. It already has
   everything it needs; this adds one `gh api repos/.../statuses/<sha>` call.
2. **Add one CI job, `Sol review on head`**, to `ci.yml`. It passes when either the PR is Sol-exempt
   (reusing `.claude/hooks/sol-exempt-lib.mjs`, the same code the merge gate uses) or a
   `crx/sol-review` success status exists on the exact head, set by an allowed account, whose base
   matches the PR's current base and is under 24 hours old. Otherwise it fails with a message
   saying how to get a Sol review. A new commit gives a new head, which has no status, so the job
   fails again, exactly as the local gate does today.
3. **Make that job required** in the `protect-main` ruleset. That is a GitHub permissions change,
   so Mason does it or approves it.

After that, GitHub refuses a merge without a Sol review for everybody, whether they click **Merge**,
use a plain terminal, or use an agent. The local hooks stay as they are, as a second check.

**What a human developer then does:** install the Codex CLI and run
`node scripts/write-codex-push-proof.mjs` on their clean checkout (option A), or ask an agent session
to run it on the PR's head (option B), then press Merge.

**Limits to know before approving it:**
- A commit status can be posted by anyone with write access, so this stops mistakes, not a
  determined insider. That is the same trust level as the local proof today. The stronger version
  runs the Sol review inside GitHub Actions with an OpenAI API key stored as a repository secret.
  It is a bigger change: a new secret (Mason's call), a cost per PR, and careful workflow security,
  because the job would run on untrusted PR code.
- The other merge-time rules (money-PR CodeRabbit review, open review threads, migration applied
  first) would still be checked only locally. They could move into the same CI job later, one at a
  time, each as its own reviewed change.
- `ci.yml` re-runs on every push; the new job must also re-run when the status is posted (a
  `status` event trigger, or a re-run the proof writer starts).

**Recommended until then:** treat option B as the rule for a human developer. Open PRs freely, and
let an agent session run the Sol pass and the merge, or install the tools first. Mason may want to
make that a written decision in `docs/manual/DECISION_LOG.md`.

## When a gate is stuck

Read the refusal first. Every gate prints which condition failed, and most print what to do.

| Refusal says | Usually means | Do this |
|---|---|---|
| No Sol proof / proof does not match head or base | A commit or a `main` merge after the review, or the review is older than 24 hours | Rerun `write-codex-push-proof.mjs` on the clean head; after a plain `main` merge, try `--carry-forward` first |
| `documentation-only exemption does not apply` | A file outside the eligible docs folders, or a never-eligible name | Run Sol, or move the file into an eligible folder |
| A check is not green / `mergeStateStatus` not CLEAN | A check failed or is pending, or the branch is behind | `gh pr checks <n>`; `gh pr update-branch <n>` if behind |
| CodeRabbit thread unresolved or has no reply | A thread from any commit | Reply on it, then resolve it |
| Money PR has no completed CodeRabbit review | Required for money PRs | Post `@coderabbitai full review` once; if it says it is rate-limited, wait the stated time and check before asking again |
| `HOLD` or a hold latch | Mason (or text read as his) said stop | Only Mason's next message clears it |
| Hook crashed or timed out (merge launcher denies) | Node, network or GitHub slow | Retry once; then `npm run agent-health` |
| Codex cannot start its sandbox on Windows | Codex app helper holding the sandbox | Quit the Codex desktop app from the tray and rerun |
| Pre-commit refuses: no ledger entry | Agent tooling or a migration changed | Add a new `docs/changelog.d/` file to the same commit |

Never get past a gate with `--no-verify`, `--admin`, `--auto`, a hand-written proof, an edited
autopilot flag or a merge from the GitHub website. If a gate is wrong, change the gate through a
reviewed PR (next section).

`npm run agent-health` checks that the agent tooling is wired correctly. Known open problems are in
`docs/manual/KNOWN_ISSUES.md`.

## Asking for a policy change

1. **Say what is wrong and show it.** The command, the refusal text, the commit, and why the rule
   blocks something it should allow (or allows something it should block).
2. **Open a PR that changes the rule and its test together.** Every hook has a `.test.mjs`. For the
   documentation exemption, `sol-exempt-lib.mjs` and `docs/reference/sol-exempt-paths.md` change in
   the same PR (a test fails if they disagree). Run `node scripts/sync-agent-workflows.mjs --write`,
   `npm run test:agent-workflows` and `npm run agent-health` after changing agent files, and update
   `docs/reference/agent-guardrails.md`.
3. **It goes through the full path with a Sol review.** Anything under `.claude/`, `.codex/`,
   `.github/`, `scripts/` or `AGENTS.md` is never Sol-exempt.
4. **Loosening a gate is Mason's decision.** He records it with a date (for example "Mason,
   2026-10-19") in `AGENTS.md` or `docs/manual/DECISION_LOG.md`. A PR that loosens a gate is merged
   by Mason himself after the review. GitHub ruleset and permission changes are his too.

## Where to read more

| Topic | File |
|---|---|
| The rules | `AGENTS.md` |
| The delivery path | `.claude/commands/ship.md` |
| Every hook and why it exists | `docs/reference/agent-guardrails.md` |
| Documentation exemption | `docs/reference/sol-exempt-paths.md` |
| CodeRabbit rules | `docs/reference/coderabbit-native-review.md` |
| Model and effort pins | `docs/reference/codex-model-tuning.md`, `docs/reference/claude-model-tuning.md` |
| How Claude and Codex work together | `docs/workflows/AGENT_COLLABORATION.md` |
| Architecture and first steps | `docs/manual/ARCHITECTURE.md`, `docs/manual/AGENT_ONBOARDING.md` |
| Decisions already made | `docs/manual/DECISION_LOG.md` |
