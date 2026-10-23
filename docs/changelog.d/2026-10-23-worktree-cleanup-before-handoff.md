## 2026-10-23 — stale worktree cleanup before the developer handoff (Goal 9)

Goal 9 ("Files and repo") asks that only finished, clean, unused worktrees be removed, after any
unpushed work is saved, with a record of what was kept and why. This is that record.

**Before / after:** `git worktree list` showed 44 worktrees before and 26 after. Nothing was
force-removed; every removal was a plain `git worktree remove`, which refuses a folder with
uncommitted changes. A worktree removal deletes only the folder. Each local branch is kept.

**Removed (18).** Each was clean, had no live Claude session and no open PR, and its commit was
either already inside `origin/main` or was the exact head GitHub merged:
`C:/CRX_apply_20260926` and `C:/CRX_braces_audit` (inside main); `C:/CRX_blend_qty_msg` (#1034),
`C:/CRX_followups` (#924), `C:/CRX_goal1_photos` (inside #929's merged head),
`C:/CRX_goal4_inventory` (#985), `C:/CRX_owner_approval` (#871), `C:/CRX_pr700` (#850),
`C:/CRX_pr827` (#827), `C:/CRX_pricingplan` (#930), `C:/CRX_rep_own_name` (#931),
`C:/CRX_replay_batch3` (#954), `C:/CRX_replay_batch3b` (#967), `C:/CRX_salesman_own_name` (#933),
`C:/CRX_season_clock` (#858), `C:/CRX_shared_shortage` (#925), `C:/CRX_tailwind4` (#877),
`C:/CRX_void_order_split` (#1008). `git worktree prune` also dropped one dead bookkeeping entry (`mainwt`). Its pointer file was
broken, so `git worktree list` never showed it, and it is not among the 44: 44 − 18 = 26.

**Saved to GitHub first.** `claude/invoicing-admin-only-20261009` (22 commits that existed only on
this PC) was pushed under its own name. One local-only commit on
`claude/autopilot-recursive-delete-alias-20260907` (`a56fef0cc`) was pushed as the new branch
`claude/autopilot-recursive-delete-alias-local-a56fef0`, because the remote branch of the same
name had moved on separately and was not overwritten.

**Stray file removed:** `cr.tmp` in the main checkout, a saved copy of a CodeRabbit
"review limit reached" comment from 2026-10-20.

**Kept, still in use by a live session (14):** the main checkout `C:/CRX_Manager`, and these
`.claude/worktrees/` folders: `epic-driscoll-67a502`, `sharp-bartik-6ba30f`, `epic-kepler-98cf42`,
`wizardly-engelbart-152f5b`, `crx-manager-scaling-prompt-be8f21` (open #1050),
`load-failure-messages-29cad2` (open #1055), `applicator-access-audit-93277b` (open #1065),
`sharp-knuth-6d8e46` (open #1064), `coderabbit-review-scope-3dffbe` (open #1061),
`fervent-zhukovsky-d8a6bf` (coordinator notes, untracked), `kind-hellman-4c52cb`,
`app-scalability-assessment-812bdb` and `strange-driscoll-1dac61`.

**Kept, has work or needs the owner's OK (12 worktrees and one separate clone):**

| Folder | Branch | What it holds | Recommendation |
|---|---|---|---|
| `.claude/worktrees/job-pick-1060` | `claude/job-pick-no-price-blanks-20261023` | Open PR #1060 plus 6 uncommitted files | Keep |
| `C:/CRX_cost_swap` | `claude/invoice-version-by-id-20261022` | Open PR #1057 (cost-lock swap A) | Keep |
| `C:/CRX_po_fingerprint` | `claude/bulk-po-fingerprint-ignores-cost-20261022` | Open PR #1058 | Keep |
| `C:/CRX_cost_lock` | `claude/cost-lock-on-postable-20261022` | Cost-lock step B, no PR yet; pushed | Keep until #1057 lands |
| `C:/CRX_admin_invoicing` | `claude/invoicing-admin-only-20261009` | Bulk-Post safety work, never merged; now pushed | Owner decides: revive or retire |
| `C:/CRX_invoice_safety` | `claude/invoice-screen-safety-20261009` | Closed PR #892; pushed | Delete folder after OK |
| `C:/CRX_mergeperm` | `claude/audit-brace-expansion-fast-uri` | Closed PR #847 (dependency fix); pushed | Delete folder after OK |
| `C:/CRX_rmguard` | `claude/autopilot-recursive-delete-alias-20260907` | Closed PR #631; commit pushed. One uncommitted edit, saved nowhere: a one-character comment fix in `.claude/hooks/autopilot-lib.mjs` (restores a missing `\`), with no behaviour change | Delete after OK; doing so discards that comment fix, so carry it into a PR first if it is wanted |
| `C:/CRX_autoland` | `claude/autonomous-landing` | Merged #804, but locked ("build session in progress", 2026-09-27) | Unlock and delete after OK |
| `.claude/worktrees/hand-of-orchestrator-ab5605` | `claude/crx-manager-backlog-review-651851` | Inside main; only generated `.agents/skills/source-command-*` folders | Delete after OK (a guard blocks agent deletes under `.claude/`) |
| Temp `scratchpad/part1` | `claude/guard-cleanup-noisy-20261002` | Merged #874; about 3,200 tracked files missing, nothing new | Force-remove after OK |
| Temp `scratchpad/smj` | `claude/bump-source-map-js-20261007` | Merged #884; same missing-file state | Force-remove after OK |
| `C:/CRX_solfix_e2e` | `claude/sol-wrapper-codex-fallback-20261008` | A separate clone (not a worktree), clean and matching GitHub | Delete after OK |

`C:/CRX_docs_facts`, `C:/CRX_split` and `C:/CRX_split2` are empty folders, each holding only a
broken `node_modules` shortcut. They are not git worktrees. A safety check stopped the agent from
removing them, so the owner can delete them.
