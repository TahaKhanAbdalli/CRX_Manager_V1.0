---
tags: [start-here, lessons]
---

# Lessons Learned

← [[Home]] · see also [[Working-with-Taha|Working with Taha]]

The mistakes that cost CRX real time, in plain English, so nobody repeats them. Each one happened at least once. The full technical list, with exact commands and file names, is `docs/reference/gotchas.md`. Read its sections before touching that area.

## Proving work

| Lesson | What to do |
|---|---|
| **Passing tests aren't proof.** A test written with a change can share the same misunderstanding as the change. About one app test in ten only checks that some code text exists. | Run the real thing (the screen, or the real database path) and watch it work. Say what you didn't check. |
| **A guard that exists isn't a guard that works.** Every Windows safety hook once failed open without anyone noticing, because the tests only checked the hooks were there. | Prove a guard by making it fire: try the thing it should block and watch it refuse. |
| **Testing as admin hides bugs for everyone else.** Several database guards skip their checks for admins, so a proof run as admin passed while the same action was broken for sales reps. | Test money and permission changes as the real role that will use them (rep, driver, applicator). |
| **The click-through tests don't run today.** They've been switched off since May 2026 because there's no staging copy to run them against. | Don't count them as protection until staging exists (Goal 6). |

## The database

| Lesson | What to do |
|---|---|
| **There is no separate test database yet.** Test scripts run against the live database inside a transaction that is rolled back (undone) at the end. | Treat every database command as live. Read-only, or `BEGIN … ROLLBACK`, unless it's a reviewed migration. |
| **An applied migration is history.** Editing it changes nothing live and breaks the rebuild. | Fix forward with a new migration. An old parked migration that no longer fits is retired with the `SUPERSEDED-` prefix, never patched to make it run. |
| **The database can't be rebuilt by replaying every migration.** Some old files are out of order. | Use the baseline snapshot in `supabase/baselines/` plus the migrations after it. |
| **Lists stop at 1,000 rows without saying so.** Supabase returns at most 1,000 rows per request. Several report totals were quietly short before they were fixed in October 2026. | Page through every list that can grow, and add totals in the database, not in the browser. |
| **Money must round the same way everywhere.** The browser and the database round halves differently, so a preview could disagree with the posted bill by a cent. | Store whole cents. Do money math in the database function that posts, and show its result. |
| **Crop RX runs on Central time.** The year computed in UTC rolls over at 6 pm Central on December 31. | Use the Chicago date for anything numbered or grouped by year. |
| **Removing public access from a database function doesn't remove signed-out access.** Supabase's anonymous role keeps its own grant. | Revoke from `anon` by name, then prove it with a call using the public key (details in gotchas). |
| **An "allow-list" and a "block-list" behave differently when you add a status.** Checks written as `NOT IN (...)` let a new status straight through. | When adding a status value, find every `NOT IN` check that should cover it. |

## Git and GitHub

| Lesson | What to do |
|---|---|
| **"Clean" doesn't mean empty.** `git status` and `git worktree remove` both hide ignored files. A "clean" folder once held the only copy of production audit evidence. | Run `git status --ignored` before deleting any working folder. |
| **Squash merges make branches look unmerged.** After a squash merge, git still reports the branch as "ahead". | Check whether a branch landed with `gh pr list --head <branch> --state all`, not by commit counts. |
| **Bring your branch up to date before opening the PR.** Reviews pin both the branch and the `main` it was compared with. Syncing after review means reviewing again. | Merge current `main` first, then open the PR. |
| **Resolving review threads doesn't clear "changes requested".** Only the next review round does. | Fix everything in one push, then ask for one new review. |
| **`git add src` sweeps in local test-harness files.** | Stage exact file paths. |
| **Never run `npm audit fix --force` on CRX.** It once downgraded React Router and broke the app. | Upgrade the one package that needs it, on purpose. |

## Windows

| Lesson | What to do |
|---|---|
| **Windows changes line endings.** Some migrations check a fingerprint of their own text, and Windows line endings change that fingerprint. | Those files carry an `eol=lf` pin in `.gitattributes`. If you rename one, move its pin too. |
| **Deleting a worktree can delete shared files.** Some worktrees link their `node_modules` to the main checkout's. | Remove the link with `cmd /c rmdir <path>\node_modules` before removing the worktree. |

## Working with Mason

| Lesson | What to do |
|---|---|
| **Settled questions keep coming back.** Agents re-asked things Mason had already decided, because the answer lived only in a chat. | Write each decision in the [[manual/DECISION_LOG\|Decision Log]] the day it's made. |
| **He reviews plans, not code.** He catches mistakes in a plain-English description, never in a diff. | Before risky work, describe in two or three sentences what will change and what could go wrong. |
| **"Stop" means stop now.** | Halt the work in progress and check in. Don't finish the current step first. |
