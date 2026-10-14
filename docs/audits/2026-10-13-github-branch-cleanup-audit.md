# GitHub branch cleanup audit and restore ledger (2026-10-13)

**Status (2026-10-14): the 157 "after yes" deletions are DONE; the 16 "after this PR" deletions are
APPROVED by Mason ("yes delete the 16") in the conversation that ran the 157, and wait for this PR to merge
and the helper's gates to pass. Any other session needs a fresh yes from Mason first.** Mason approved the 157 batch on 2026-10-14. It paused once
after 77 deletes, when PR #906 merged, and resumed under the re-baseline and the standing approval
recorded in "Second re-baseline" below, which cover only the rest of that batch. The helper's sweep then
reported all 157 gone with every restore source intact, and all 12 kept branches unchanged. The report
below was revised after four rounds of independent review and a two-pass salvage review. Mason asked on
2026-10-13 to "analyze all our branches we have in github … remove what is useless and cleanup", then to
have Codex Sol 6.1 review the proposal before anything happens. Every measurement behind this document
was read-only. Branch deletion is a hard-gated action (`AGENTS.md`), so the deletions below wait for
Mason's explicit yes in the conversation. When they run, this file is the restore ledger.

## The answer

- **GitHub held 191 branches besides `main` at the audit.** The 6 that belonged to open PRs (#897-#902,
  including this report's own PR #901 and admin-only invoicing #902, since closed) are out of scope. Of
  the other 185: **173 can be deleted and 12 stay.** Two salvage reviews and Mason's 2026-10-13 answers
  moved 6 branches from the delete list to "stay" (see "Salvage review").
- **Nothing is lost by deleting the 173.** Each one's work either merged under a later PR (most are
  "delivery laps": a PR closed and reopened as a fresh branch until one merged), was deliberately
  dropped by a Mason decision, or was made obsolete by `main`. 157 can go after Mason's yes; 16 wait
  until this PR merges, because this PR rescues or repoints something on them.
- **Every deleted branch stays restorable.** 161 tips are the final commit of their PR, which GitHub
  keeps as `refs/pull/<N>/head` (fetching four of them back, from July to October, returned exactly the
  branch tips). 11 get a new `archive/2026-10-13/<branch>` tag, made and read back before any deletion, and 1
  already has a tag. A verified local bundle of all 185 candidate tips is a second, independent copy.
- **No live database change is at risk** (proved, not inferred; see "Database").
- **Rescued in this PR:** two owner decisions that never reached `DECISION_LOG.md`; Revisions 12-13 of the
  product data model plan; and new `KNOWN_ISSUES.md` entries.
  - The decisions are the 2026-08-09 pricing answers, including "commission is clawed back on returns",
    which a full trace shows is not built, and the 2026-08-27 ingredient identity model D-AA.
  - The new entries cover two latent quote bugs, a HIGH permission gap for connected MCP tools, the
    review-proof forgery class, and a list of small notes.

## The independent review (Codex `gpt-6.1-sol`, 2026-10-13)

Mason asked for a Codex Sol 6.1 review before any deletion, so its findings must be fixed, or explicitly
accepted by Mason, before any branch is deleted. It is not a merge gate: `gpt-6.1-sol` is newer than the
`gpt-6-sol` the merge gates pin, and PR #901 itself is a documentation-only change that the gates exempt
from Sol. Round 1 ran read-only (`--sandbox read-only --ignore-user-config --ephemeral`) at `xhigh` effort
on an 810 KB inline packet:
- this proposal, PR #901's diff and the source text of every rescued record;
- Claude's live facts, the prior-decisions summary and the completeness critic;
- every branch's evidence.

The run was validated: exit 0, the end-of-packet canary echoed, exactly one verdict line. **Verdict: BLOCK,
45 findings (5 HIGH).** Claude agreed with nearly all of them and changed the proposal:

| Sol finding | What changed |
|---|---|
| HIGH: `audit-brace-expansion-fast-uri` is checked out at `C:/CRX_mergeperm` | Moved to KEEP |
| HIGH: F3's "branch stays until" condition was not discharged | `control-file-coverage-a41c` moved to Mason's call; KNOWN_ISSUES restored to say the branch stays |
| HIGH: product-plan rescue was only a pointer | Revisions 12-13 merged into the plan itself (clean three-way merge, no conflicts; one qualifier added later at CodeRabbit's request) |
| HIGH: check-then-delete race could lose a newly pushed commit | Deletion now uses one atomic GitHub `updateRefs` call per branch that deletes ONLY if the branch still points at the ledger commit (round 2 moved tag creation to an ordinary push, so `updateRefs` only deletes) |
| HIGH: no fresh PR check right before deletion | Procedure re-reads every PR (all states, as head AND base) immediately before each batch |
| MED: D-AA, pricing and below-cost text lost precision | Rewritten from the source: CAS backfills go through the D-I queue, no-signal rows stay visibly separate, D-AA-4 marked "settled technically"; the no-backfill boundary is "issued before the apply"; the below-cost wall's locked-cost, whole-surface and fail-closed rules restored; clawback kept as settled |
| MED: "clawback not built" rested on a keyword search | Replaced by a full trace of the live catalog and `main` (no function, trigger, view, job or app code touches commission on a return; `commission_amount >= 0` forbids a negative row) |
| MED: accepted-quote finding not rescued; quote "nobody affected" overstated | Both quote findings traced on `main` and recorded; exposure stated precisely (4 idle quotes) |
| MED: MCP gap understated | Re-measured against the hooks and both settings files: seven connected tools (deploy, rollback, env vars, pause project, delete branch, edge-function secret, email send) run with no prompt; raised to HIGH |
| MED: forgery entry narrower than its source | Restored the broader limitation (constructed paths, outside hard links, check/open races) |
| MED: unexplained leftovers on six branches | Each disposed: recorded as a small note in KNOWN_ISSUES or shown covered on `main`; those branches wait for this PR |
| MED: docs said "removed" before anything was removed | All pointers reworded to stay true before and after deletion |
| MED: migration check matched names, not contents | Fingerprint check added (see "Database") |
| MED: #893 moved `main` mid-audit | Every branch re-measured at `7abd52f6d` (see "Baseline") |
| LOW items (counts, dates, narratives) | Corrected below |

Two Sol points were checked and turned out narrower than stated:
- **git clean.** The reported `git clean` variants are all blocked by `main`'s guard; the real gap is
  narrower and is recorded as measured.
- **Same-day keeps.** Mason's earlier same-day "remove them" concerned the worktrees `C:/CRX_874` and
  `C:/CRX_solfix`. Their GitHub branches (#874, #882, #890) merged and were auto-deleted, so none is on
  this list.

**Round 2** (same settings, a 996 KB packet that also carried Sol's round-1 text, every changed `src/` and
`supabase/` file per branch untruncated, and the round-2 evidence) returned **BLOCK, 33 open**:
- **Round 1:** 30 of 45 findings FIXED, including all five HIGH; 15 PARTLY or NOT FIXED.
- **New:** 18 findings, 5 HIGH, about the deletion procedure.

This revision addresses them:

| Round-2 finding | What changed |
|---|---|
| HIGH N1: a PR, session or worktree could adopt a branch after the pre-flight | Checks moved to each branch immediately before its delete, plus a post-batch sweep that restores any branch a new PR points at |
| HIGH N2: preservation was verified after deletion | Every restore source is verified before the first deletion of a batch |
| HIGH N3: creating tags through the API skipped the pre-push hook | Tags are created with an ordinary `git push` (the pre-push hook runs, as in the 2026-09-01 and 09-03 runs); the API call only deletes |
| HIGH N4: the ledger had to be published first | Each batch requires the ledger at PR #901's live head to list every branch and commit in the batch |
| HIGH N5: "after #901 merges" was too loose | The 17 also require each rescued record to be present on `origin/main` |
| MED N6: review called non-gating | Reworded above |
| MED N7: `main` or rules could change after review | Each batch re-measures against the then-current `main` and drops any branch whose unlanded set grew |
| MED N8: migration copy count units | Units stated (see "Database") |
| MED N9: "no rep overpaid" unsupported | Removed |
| MED N10: Net 30 note understated | Reclassified MED against the 2026-09-03 rule; needs a post-path trace |
| MED N12-N14: product-plan design questions | Recorded in the plan header as open questions for WP-1 design (the plan text is PR #507's, merged unchanged; designing it is outside this cleanup) |
| MED N18: failure handling | Stop on any mismatch or unknown outcome, reconcile, record actual results |
| LOW N11, N15-N17 | Quote product-swap identity rule added; KNOWN_ISSUES header count fixed; baseline wording fixed; rep-scoping release condition expanded |
| R1 #3, #7, #12, #20, #21, #24-#26, #32-#34, #42, #43, #45 | `.claude/agents/**` caveat added to F3; no-backfill boundary bound to ledger `20260901182753`; quote exposure worded precisely; E2E-marker guard gap measured and recorded; `save_field` behavior read from its live body; memory notes and the 2026-09-28 changelog repointed; remaining "removed/kept" wording made prospective; section1's tag added to post-flight; a verified local bundle added as an independent fallback; the planned commands run through every hook (all allow); notes below on skeptic coverage, superseded narratives and pr364 |

**Coverage notes.**
- **No skeptics on `backup/pr432-multitarget-20260825`.** Round 1 put it to Mason, so it was never
  skeptic-challenged. Its deletion now rests on the investigator's evidence, the prior-reports reader
  (#432 frozen permanently on 2026-08-25) and Sol's own round-1 finding #44.
- **Superseded narratives.** Where a round-1 investigator narrative and this report disagree, this report
  wins. Known corrections:
  - the field-season install laps were cherry-picked into #871, not literal ancestors;
  - `codex/lean-agent-docs-20260904` is a parallel commit, not one on top of #600;
  - lap 19's successor carries more merges than stated;
  - the download-revoke v3 branch already has the cited postflight check.
- **pr364.** The pr364 branch could also be retired later by an approved swap to an archive tag plus a
  `KNOWN_ISSUES.md` repoint, without declining its protections; that is not proposed here.

**Round 3** (a 1,028 KB packet adding the round-2 text) returned **BLOCK, 18 open**:
- **Still open from round 2:** 10 items, three of them HIGH (N1, N4, N5).
- **New:** 8 findings, one HIGH (R3-1).

Sol judged several choices acceptable for Mason to approve:
- keeping the six protected branches;
- tagging the frozen PR #432 backup instead of keeping it as a branch;
- recording, not redesigning, the product plan's open questions;
- keeping historical narratives that carry explicit corrections;
- a local-only bundle, once recovery is shown.

This revision answers the rest:

| Round-3 finding | What changed |
|---|---|
| HIGH R3-1: the per-branch checks did not say "refuse" | The written procedure and the script refuse on an open head/base PR, a checkout, a session, a moved tip, a broken restore source, or any lookup that fails |
| HIGH N4: execution not bound to the approved ledger | The script reads the ledger only from the commit Mason approves and refuses if the published ledger differs from it byte for byte |
| HIGH N5: "PR merged" too loose for the 18 | The script requires #901 merged at exactly the approved commit, APPROVED, every check green, and each branch's rescue marker present on `main` |
| HIGH N1: the post-batch sweep covered only PRs | The sweep also checks worktrees and active sessions, and restores create-if-absent; the remaining seconds-long window is stated as the one residual |
| MED R3-2: the newly rescued #639 finding was in the first batch | `claude/live-data-guard-comment-aware` moved to "after this PR" (now 159 and 18) |
| MED R3-3, R1-33: bundle prerequisites and recovery unproven | Recovery demonstrated in a separate clone (185/185 refs, 18,000 objects, 0 missing); the 197 prerequisite commits are named as `main` history |
| MED R3-4: restore could overwrite a recreated branch | Restore is create-if-absent; a collision is reported, never overwritten |
| MED R3-5: no reviewable script | The script and its baseline are in the review packet and are the exact files that will run |
| MED R3-6: quote exposure overstated | Checked live: one real customer's quote is accepted with no order (since 2026-07-19, never held stock); recorded, and the assurance removed |
| MED N6, N7, R1-34 | Approval limits stated; the refresh rule also catches new references on `main`; the first deletion runs alone as a canary |
| MED R1-36: incomplete per-file dispositions | Containment proof added (99 of 177 deletion tips are inside a merged PR's head); the round-4 packet lists every changed file for the other 78 |
| MED R1-20 | PR #639's backslash caveat recorded |
| LOW R3-7, R3-8, R1-26 | The quote fix's reference commit `dec5d3378` is named on both branches; the recovered August changelog note now says it is recovered; the changelog wording no longer claims anything is already on `main` |

**Round 4** reviewed the helper script line by line and returned **BLOCK, 26 open**, five of them HIGH:
- S01: adoption detection incomplete;
- S02: printed commands disconnected from the gates;
- S03: rescue markers not proving fidelity;
- S04: weak review and check gate;
- S08: repository identity not bound.

N1, N4 and N5 had now survived two fix rounds. So, as the project rule requires, the loop stopped and Mason
was given both positions. He chose "fix and go": fix the remaining defects without another review round,
finish this PR through its normal review, then ask him for the deletion yes. Version 2 of the helper
answers round 4:

| Round-4 finding | What changed (version 2) |
|---|---|
| HIGH S02 / N4: commands disconnected from the gates | Every `check` re-runs every gate (identity, publication, docs gate, refresh, preservation, bundle) immediately before its delete |
| HIGH S03 / N5: markers do not prove fidelity | Every rescued file must be byte-for-byte identical between the merge commit and the approved commit; markers must still be on `main` |
| HIGH S04: weak review/check gate | CodeRabbit's latest verdict must be APPROVED on the exact approved commit; each required check must be green there, and an empty or truncated check list refuses |
| HIGH S08: repository identity | `origin`'s fetch and push URLs and GitHub's live repository ID must match before anything runs |
| HIGH S01 / N1: adoption detection | Session list must be under 30 minutes old and well-formed. Worktree HEAD and folder matching are added, and `sweep` reports any target still present. The residual the helper cannot see is stated exactly and does not lose commits |
| MED S05, S06, S12, S13 + Codex P2 on this PR | Refresh compares the exact lines naming each branch, the full `protect-main` rules snapshot (types and parameters), and any file `main` changed since review that the branch also changes. #901's own edits are excluded, and deleted files are handled |
| MED S07, S09, S10, S11, S14, S15, S17, S18, S19 | Malformed sessions and unreadable ref listings refuse. The ledger is a sealed whitelist with exact counts. Printed text is restricted to safe characters. The bundle is hashed and verified. `sweep` reports present targets and validates its time. Truncated lists refuse. `confirm-restore` exists. Every error exits as a refusal |
| MED N01 / R1-33: bundle independence | Recovery repeated in a brand-new empty repository holding only `main` (see "Restoring a branch") |
| MED N02 / R1-36 | The containment proof now says "every commit was inside a merged PR's history", not "every change landed" |
| MED N03 / N6 | The approval limits now exclude accepting any HIGH that names a missing control |
| LOW S16, S20, S21 | Wording fixed; the helper refuses the whole batch instead of dropping branches |
| LOW N05 | PR #605's non-canonical path finding is recorded as historical and unverified |
| CodeRabbit on this PR | The 8.3 wording is narrowed to the measured review-proof path |

**One round-4 claim was checked and is wrong.** N04 said the baseline omitted five "after yes" rows, so a
successful `plan` was impossible. The baseline holds all 185 rows, including those five. The excerpt shown
to Sol started at the second printed command, not the first; that was an excerpt error, not a ledger one.

**Version-2 test results (read-only, against the published head `de661f871`).**
- **Main suite: 21 of 25 exactly as expected.** The other four also refused, for a reason the test did not
  predict:
  - every per-branch check refuses until the archive tags exist (by design);
  - an older ledger is refused at the publication gate before the row-count gate.
- **Per-branch suite: 9 of 9.** Run against the #449 row, which needs no new tag, it proved:
  - `OK` for that row;
  - refusals for another batch's branch, `main`, a kept branch, an adopting session, a stale session list,
    a malformed list and a missing list;
  - a successful `verify-tags`.

  Further cases:
  - a valid but unpublished ledger, built as an unreferenced local commit, was refused;
  - a repository whose `origin` is not CRX Manager was refused;
  - the `--since` checks behaved as designed;
  - `sweep` reported a still-present target.
- **Printed commands.** `plan --batch now` printed 159 delete commands and one 7-tag push, and named
  `refs/heads/main` nowhere.

The full reviews are kept with the session record.

## Baseline and method

| | |
|---|---|
| `origin/main` | first measured at `af0ce0c4c`; every branch re-measured at `7abd52f6d` after #893 merged. 19 branches changed class. In 18 field-season laps the only change was that `FieldApplicationInvoiceRoute.tsx` became MAIN-MOVED, and each holds exactly the pre-#893 `main` version of that file. `invoice-screen-safety` became more landed. No tip moved. |
| Branches | `git ls-remote --heads origin`: 192 heads = `main` + 191 |
| PRs | `gh pr list --state all --limit 5000` (the default limit is 30): 889 PRs, every PR then, matching the 889 `refs/pull/*/head` refs; matched to branches by head name |
| Repo setting | "Automatically delete head branches" is ON, so merged PRs clean up after themselves; the pile-up is closed-but-not-merged PRs, which GitHub never deletes |

**How each branch was measured** (the method from `docs/audits/2026-09-02-github-branch-cleanup-audit.md`):
every file a branch changed since its merge base was classed against `main` by content hash:
- IDENTICAL (landed);
- ABSENT (new file `main` lacks);
- BRANCH-ONLY (`main` never touched it);
- MAIN-MOVED (both changed it; scored by the share of the branch's added lines present verbatim on
  `main`).

Commit counts and three-dot diffs were not used as evidence, because this repository squash-merges.

**Who checked it.** A 56-agent read-only workflow:
- one investigator per topic group (18 groups), which read every PR and its closing comments and
  confirmed each successor PR;
- two skeptics on each delete or rescue verdict, one for code and migrations and one for records (the 6
  keep/ask verdicts were not challenged);
- a reader of every earlier branch report;
- a completeness critic, which confirmed every successor PR the verdicts cite (59 distinct, all MERGED;
  the one closed PR it lists, #807, is a split branch's own PR) and re-ran 8 delete verdicts end to end.

Then three targeted verifications and the Sol review above. Live checks were read-only `SELECT`s.

**Containment proof (added in round 3).**
- **Proven mechanically: 99 of the 177 deletion tips proposed at round 3** (98 of today's 173, since
  `claude/invoice-screen-safety-20261009` now stays). In a scratch clone holding every PR's saved head
  (`refs/pull/*/head`, 889 refs), each of these tips is an ancestor of the head of at least one MERGED PR.
  Every commit on such a branch is in the history of a PR that was reviewed and merged. That proves the
  work was inside a merged PR's history; it does not prove every intermediate change landed, because later
  commits in that PR may have revised or reverted it (as with lap 9's discarded trigger).
- **Resting on stated reasons: the other 78 (75 of today's 173).** Abandoned designs, Mason's decisions, rebuilt or
  cherry-picked copies, and duplicates. Each is stated per branch in the evidence. Their complete changed-file
  lists went to the round-4 review.

## Database

Deleting branches cannot strand a live database change:
- **Every live migration is on `main`.** All 1,024 applied migrations exist on `main` by name.
- **`main` holds exactly what ran.** For the 23 applied migrations whose names also appear on branches,
  the SQL the live database recorded when it applied them (fingerprint of
  `supabase_migrations.schema_migrations.statements`) matches `main`'s file in all 23 cases.
- **The branch drafts are earlier versions.** Branches carry 136 per-branch copies of those 23
  migrations, under 34 distinct file names, which reduce to 49 distinct (file name, content) versions. Of
  the 49:
  - 7 match the live fingerprint and are byte-identical to `main`;
  - 42 differ and are earlier drafts that were never what ran.
- **Unapplied drafts.** 10 migrations (18 file versions across branches) exist only on branches and were
  never applied. Each was replaced, decided against, or is parked on a kept branch.

## Earlier decisions: what still binds and what today's request supersedes

- **Superseded by Mason's 2026-10-13 request:**
  - the 2026-08-24 "do not delete anything while work is in flight";
  - the 2026-09-02 "leave the closed-PR branches / no further deletion pass";
  - the 2026-09-11 backlog plan's "cleanup after the queue drains" sequencing;
  - the "branch kept; reopen if needed" notes on PRs closed in the 2026-09-30 triage. Each of those PRs
    stays restorable from its page.
- **Still binding, so these branches stay:**
  - the pr364 protections (`KNOWN_ISSUES.md` says "Do not delete that branch");
  - open issue #747's evidence branch;
  - the parked control-character fix;
  - two branches checked out in folders on this PC;
  - rep scoping, until its replacement #902 lands.
- **Only Mason can reverse these:** F3's retention condition, and PR #449's branch, which he chose to keep.
  The `backup/` copy of PR #432's frozen work is now an ordinary deletion: the 2026-09-02 "backup/* stays"
  line was an agent-written default, and an archive tag keeps the identical offsite copy.

## What happens to each branch

**Delete after Mason's yes (157).** Superseded laps, duplicates and abandoned designs:

- **Job-to-invoice transfer retries (22)** were 19 delivery laps of PR #638 plus a 3-lap follow-up. They
  landed as #721 and #757; every lap tip is an ancestor of a merged head.
- **Field-application filed-season guard (26 across two groups)** landed as lap 20, PR #850 (`4e145adbc`),
  live 2026-10-02. The install docs landed as #871 (cherry-picked commits with identical subjects), and the
  test-date fixes were overtaken by #857.
- **Inventory hold and adjustment retries (21)** were PR #624's laps. They landed as #682 and #691, live
  2026-09-15.
- **`adjust_inventory` receipt binding (10 laps)** landed as #739 (`17826e9c3`), live 2026-09-20.
- **Docs cleanup (19)** landed as #830, #839 and #866-#869.
- **Migration bookkeeping (11)**: restamps, applied-live records and registry refreshes, each merged under a
  later PR.
- **CodeRabbit and merge-gate attempts (10)** were overtaken by #456, #570, #571, #657, #706, #804 and #888.
- **Guard fixes (13 across two groups)** either landed under other PRs (#630, #794, #855, #455, #564)
  or were dropped by Mason's 2026-08-25 freeze and 2026-10-02 guard policy.
- **Customer documents (6)** landed as #764, #800 and #875, verified live 2026-10-04.
- **Dependency advisories (4)** were duplicates of #645 and #844.
- **Permissions and owner approval (4)** landed as #841, #857 and #894.
- **Leftovers (11)**, each covered elsewhere: return-credit work rebuilt as #509 (live 2026-09-01);
  PRs merged under other numbers (#321 as #322; #491 as #500; #468 as #465; #363's
  follow-ups via #399; `claude/pr611-land-20260905` as #611); #373, which sits inside retired #449; two
  integrity-report PRs resolved by #889; and a 2026-09-08 snapshot of uncommitted files, all superseded.

**Delete after this PR merges (16).** This PR rescues or repoints something on each:

| PR | What this PR rescues or repoints |
|---|---|
| #612 | Review-proof forgery class |
| #605 | MCP permission gap |
| #507 | Plan Revisions 12-13; D-AA |
| #591 | Changelog citation |
| #527 | git clean note |
| #532 | Prover note |
| #672 | Test note |
| #395 | Test note |
| #639 | E2E-marker guard gap |
| `codex/idempotency-reset-order-hardening-20260802` (cited by F1's original report) | Pointer |
| `codex/section1-security-hardening-20260725` (section1) | Pointer |
| `claude/bind-adjust-inventory-receipt-delivery-20260917` (the cited `adjust_inventory` lap) | Pointer |
| `claude/bulk-import-retry-scopes` (the bulk-import branch) | `save_field` note |
| `claude/customer-document-rep-remove-page`, `-v2` and `-v3` (the three customer-document page branches) | Pointers |

The table has 14 lines because the last line covers three branches: 9 PRs plus 7 named branches make
the 16 "after this PR" rows of the restore ledger below.

**Kept (12)**, each with the reason it stays. The first six were kept by the audit; the last six by Mason on
2026-10-13 ("keep all of the branches you have in question"), after the salvage review:

| Branch | Commit | Why it stays |
|---|---|---|
| `claude/pr364-guard-commits-local-20260831` | `57d27e79105b62ee9887d59bdd1f2f58ed3c0e2d` | KNOWN_ISSUES says "Do not delete that branch": the only copy of three migration-apply protections main lacks (no PR copy). |
| `claude/adjust-inventory-control-char-keys-20260920` | `4bcb1d5e33e8436c97a28733db444713ebabe681` | KNOWN_ISSUES points here for the parked (accepted-residual) control-character fix; no PR copy. |
| `claude/audit-brace-expansion-fast-uri` | `6ead36f7bf48f8b1eaef1bf1bd81ced1c21a377a` | Checked out at C:/CRX_mergeperm; held until that folder is dealt with separately (nothing unique on it; PR #847 keeps the tip). |
| `claude/autopilot-recursive-delete-alias-20260907` | `00cb318708b3048aa2a71fe7a58d97e8e02a3492` | Checked out at C:/CRX_rmguard, which holds one unpushed commit and one uncommitted edit. |
| `claude/return-credit-chain-applied-2026-09-01` | `56812f3dd5e28c551a5e5dcb40898d88c2b6ead8` | Open issue #747 names this branch as its evidence. |
| `claude/rep-scope-order-invoices` | `322cbbd04d00ebbe0001e5b4c311b216bbd9b63b` | Holds the only copy of the split-invoice type allow-list code (migration `20261008120000`, about lines 339-344) and four billing findings, now recorded in `KNOWN_ISSUES.md` by this PR. Admin-only invoicing PR #902, once its planned replacement, was closed unmerged on 2026-10-13 when Mason decided reps invoice any customer. Release when the allow-list is built or consciously dropped, and the 2026-10-06 DECISION_LOG text calling rep scoping the next change is reconciled with Mason's later decisions. |
| `codex/pr389-coderabbit-fixes` | `203a4742a9c2f072de63db52848035ebda510b98` | PR #397. The largest quote-pricing branch: quote line identity and quote-time cost on screen (`dec5d3378`, `8e147f40d`, `b3d2bba0d`, `81240c6f3`), Convert to Order atomicity (`dc4ad87fd`), profitability reports on the as-of-sale report (`d03a60fc9`) and its database test. Template for the pricing plan. |
| `claude/pricing-audit-strategy-jym8rr` | `f4eaa8259834405d26ae11b57ed454e881d94ec9` | PR #350. An earlier version of the quote line-identity screen code that installs the `item_ids` the database returns; its pricing decisions are recorded by this PR. |
| `claude/invoice-screen-safety-20261009` | `f6d996e56892d7118d9546dbdc41a20b1bbbc3d4` | PR #892. At `3507b92c5^`, the only copy of the invoice editor's "no Post, Print or Email with unsaved edits" code, removed from #892 and absent from `main`. |
| `backup/pr432-multitarget-20260825` | `5ffda1dd4c1e928f9b22d6ca7ffad16035dbe079` | Offsite copy of the frozen PR #432 guard work that Mason approved pushing on 2026-09-03 (also contains `codex/pr402-review-gaps-20260819`). |
| `claude/control-file-coverage-a41c` | `b985e919bef5e3dea538f7c6b9b5fd5b9d76a908` | F3 (nine files to add to the permission ask list). KNOWN_ISSUES says the branch stays until F3 lands; no PR copy. |
| `codex/actor-binding-mixed-notation-repair-20260810` | `b73dfc9ff7881814cf81f1d3c01d04fab212dc92` | PR #449, which Mason retired on 2026-09-12 and chose to keep the branch of (also contains `codex/harden-actor-binding-sql-reader`). |

**Mason's call (0).** Both questions were answered on 2026-10-13: keep F3's branch and PR #449's branch
(now in the table above). No branch waits on a further answer.

## Salvage review (2026-10-13, after the Sol rounds)

Mason asked for an adversarial review of the branches for work worth reusing, his example being "pricing
history lookup and cost tracking on products for quoting". Two read-only passes ran, each with a skeptic
per scope:
- **Pass 1 (file status, 13 agents).** It compared each branch's changed files with `main` and found real
  reusable work that the audit's one-line reasons hid. That work is on PR #397 (the quote screen's half of
  quote-time cost, Convert to Order atomicity, profitability reports), PR #350 (an earlier line-identity
  version) and PR #892 (the invoice editor's unsaved-edits guard, at `3507b92c5^`). The audit had wrongly
  said nothing on #892 was missing.
- **Pass 2 (content, 13 agents).** A script took every line each branch added since it forked and kept the
  lines found nowhere in `main`'s whole tree: 21,567 lines on 163 branches, in 227 groups. Every group got
  a verdict. It found no further branch to keep, but several things worth recording, which this PR adds to
  `KNOWN_ISSUES.md`: the landlord split-billing refusal, the unbuilt split-invoice type allow-list, the
  autopilot delete-spelling gap (reproduced by calling `autopilotDecision`), and the profitability
  database test on #397.
- **Limits of pass 2.** It sees only added lines, not deletions. It scanned product folders, not
  `.claude/`, agent tooling or `docs/manual`. The 22 branches with no orphan lines rest on pass 1.
- **Outcome.** Mason kept all six branches in question (the table above). The pricing work is set as the
  next section of work, planned before it is built, in a separate change.

## Other things this audit found (not deletion blockers)

1. **HIGH: connected MCP tools run without a prompt.** That includes Vercel deploy, rollback and
   environment changes, a Supabase project pause, and email send, because `migration-apply-guard.mjs`
   returns an explicit allow and no ask/deny rule names those tools. The Vercel denies are spelled for a
   different server name. Recorded in `KNOWN_ISSUES.md` as its own reviewed fix.
2. **Two latent quote bugs**, recorded with fix shapes:
   - **Re-save refusal:** none of the 4 live quotes currently holds a repeated product.
   - **Convert to Order:** one real customer's quote has been `accepted` with no order since 2026-07-19
     (3 lines, no stock ever held). That matches this bug, or a manual accept. Mason should check whether
     the customer still expects an order.
   - Re-saving a quote with two lines of one product is refused.
   - Convert to Order can leave an accepted quote with no order and its holds released.
3. **Commission clawback on returns (Mason, 2026-08-09) was never built.** The trace and live data are in
   `KNOWN_ISSUES.md` (moved there from the decision log, which keeps entries short).
3a. **Two more guard gaps, measured with synthetic hook input and recorded in `KNOWN_ISSUES.md`:**
   - **Live-data guard:** an `[E2E]` marker anywhere in a SQL batch exempts a live-data delete beside it.
   - **GraphQL ref updates:** local hooks do not inspect them at all; for `main`, GitHub's `protect-main`
     ruleset is the boundary.
3b. **`save_field` reports success for a missing field id**, and transfer-created field invoices are stamped
   Net 30 regardless of the customer's terms. Both are recorded; the second needs a post-path trace
   against Mason's 2026-09-03 rule.
4. **Stale tracking for PR #638's migration.** GitHub issue #669 ("Must fix before apply: … no enforced
   post-lock deadline") is still OPEN, though `20260914100800` went live 2026-09-27 without that fix.
   Left for a separate reconcile, because commenting on or closing an issue is outward-facing.
5. **Work on this PC, untouched by this cleanup:**
   - `C:/CRX_rmguard` holds an unpushed 229-line commit and an uncommitted edit (the kept recursive-delete
     branch).
   - The local `codex/pr402-review-gaps-20260819` holds the unpushed commit `9c9e9895c`, which is in the
     2026-09-24 private backup; deleting the GitHub branch does not touch it.
   - Four local branches are 1 to 19 commits ahead of GitHub, but each extra commit is a merge of `main`
     or already inside a merged PR.
   - **Deleting a GitHub branch never removes a local branch, worktree or folder, and Mason's approval
     here does not cover any of those.**

## Deletion procedure (for each batch, after Mason's yes)

The batches are: the 157 "after yes" rows and the 16 "after this PR" rows. No "Mason's call" rows remain:
Mason answered both on 2026-10-13 (keep).

**The helper (version 2, after Sol's round 4).** Every step below is done by one script kept next to the
local bundle at `C:/Users/mason/CRX_branch_archive/branch-cleanup-2026-10-13.mjs`, with its review baseline
`2026-10-13-cleanup-baseline.json`. Their SHA-256 values, checked before each run, are:
- script: `e80f52bf633c09edd6ced6956ab7629683c1eadd0ebc25029175befe38621988` (2026-10-13 salvage revision:
  only the sealed counts 157/16/0 and the "Mason's call (0)" marker changed)
- baseline: `43086de83b6dcfc73aa846a55c440803ed6094531bb2d24cbde8c6f46105d9c0` (re-measured at `main`
  `ca20e4757` on 2026-10-14, after PRs #911, #912, #915 and #916 merged, before the "after this PR" batch;
  the earlier files are kept beside it: `2026-10-13-cleanup-baseline.at-5976d3dbc.json`, hash
  `236949fd…df36f`; `2026-10-13-cleanup-baseline.at-95f3c563c.json`, hash `dbf459d4…a44e`;
  `2026-10-13-cleanup-baseline.at-d12fc0f2a.json`, hash `9813b04a…dcb7`;
  `2026-10-13-cleanup-baseline.at-eec473890.json`, hash `60176b3f…b002`;
  `2026-10-13-cleanup-baseline.at-395bdcd9a.json`, hash `9db70b71…4219`;
  `2026-10-13-cleanup-baseline.at-82c8c0817.json`, hash `127e4dc2…d533`;
  `2026-10-13-cleanup-baseline.at-22c10c8df.json`, hash `60ca1426…54c0`; and the review-time
  `2026-10-13-cleanup-baseline.at-7abd52f6d.json`, hash `0cbdd535…1d75`)
- bundle: `dd0a305b3531e418d5a5ab4633c3c16b08dab41c35ff28536f08e997faf98b1d`

A different file must not run.

**Re-baseline on 2026-10-13, and how to repeat it.** After #900 and #904 merged, the helper refused the whole
"after yes" batch, as designed: `main` had changed files such as `DECISION_LOG.md` and `ship.md` that many
batch branches also change. The fix was not to loosen the rule. Every one of the 185 branches was
re-classified against the new `main` with the audit's exact method (blob identity, MAIN-MOVED counted landed
at 90% or more), and the result compared with the reviewed baseline:
- 0 branches gained an unlanded path;
- 0 changed at all;
- the `protect-main` rules were unchanged.

Only then was the baseline rewritten at the new `main`. Repeat exactly this, and nothing looser, whenever
`main` moves before a batch runs. If any branch gains an unlanded path, it goes back for review. After the
salvage revision, the helper's read-only tests gave 25 of 28 exact results. The other 3 refused at an
earlier gate (publication binding twice; preservation, before the tags exist). `plan --batch now` printed
157 deletes and never named `refs/heads/main`.

**Second re-baseline, 2026-10-14, mid-batch.** Mason approved the 157 batch on 2026-10-14. After 77 deletes,
PR #906 (React 19) merged and the helper refused the batch again, as designed. The re-measure at
`82c8c0817` found 183 of 185 branches unchanged, and two that changed only because of #906's own edits:
- `codex/autonomy-with-hard-boundaries-20260827`: `docs/operations/production-runbook.md` moved from
  BRANCH-ONLY to MAIN-MOVED, because #906 changed that file's "React 18" line to "React 19". The branch's
  unlanded change is the same one already reviewed.
- `codex/pr624-batch-retry-integration-20260913`, already deleted before #906 merged:
  `src/components/inventory/BatchAdjustModal.tsx` fell below the 90% landed mark, because #906 rewrote that
  file's frozen-batch effect. The branch's tip is still restorable from PR #689, as its row says.

Both went back for review, as the rule above requires. Mason approved the re-baseline on 2026-10-14 ("yes
re-snapshot and finish"), with standing approval for the rest of this batch: whenever `main` moves, re-measure;
if no branch gains an unlanded path, re-baseline and continue; otherwise stop and ask him. No referencing
line in the six watched documents changed, and the `protect-main` rules were unchanged.

**Third re-baseline, 2026-10-14, before the "after this PR" batch.** After the 157 finished, PR #907 merged
(`main` `395bdcd9a`). The re-measure found all 173 deletion rows unchanged. The only change was on a KEPT
branch, `claude/rep-scope-order-invoices`: three paths it already held unlanded (`RLS_SECURITY_GUIDE.md`,
`smoke-specs.json`, `src/lib/db.ts`) moved from BRANCH-ONLY to MAIN-MOVED because #907 edited them. No
branch gained an unlanded path, so the rule above allowed the re-baseline. Mason gave his yes for the 16
the same day ("yes delete the 16"), after being told they would run only once this PR merged. That yes is
the batch's approval only in the conversation where Mason gave it (`AGENTS.md`: approval must be in the
current conversation). If that conversation runs the batch, it asks nothing further. Any other session
must get a fresh yes from Mason in its own conversation first. Either way, the batch runs only after the
merge and only if the helper's "after this PR" gates all pass on the merged state. PR #909 then merged (`main` `eec473890`); the re-measure there found all
185 branches unchanged, so the baseline was rewritten once more at that `main`. PR #908 then merged
(`main` `d12fc0f2a`); again all 185 were unchanged, and the baseline was rewritten at that `main`. PR #905 then merged
(`main` `95f3c563c`). All 185 were again unchanged. Its `TODO.md` now names three KEPT branches
(`codex/pr389-coderabbit-fixes`, `claude/pricing-audit-strategy-jym8rr`,
`claude/invoice-screen-safety-20261009`) as pricing-plan sources; no deletion row is newly named, so the
baseline was rewritten at that `main` with those three references recorded. PR #914 then merged
(`main` `5976d3dbc`); all 185 were unchanged, and the baseline was rewritten at that `main`. PRs #911,
#912, #915 and #916 then merged (`main` `ca20e4757`). The two docs-cleanup PRs rewrote old documents that
14 branches also edit, so those 14 gained MAIN-MOVED paths. All 14 were already deleted in the "after
yes" batch and stay restorable from their PRs; none of the 16 "after this PR" branches changed, and no
deletion row is newly named in the watched documents. The baseline was rewritten at that `main`.

**Landing this record.** Each re-baseline edits only this file, so the PR stays documentation-only under
`docs/reference/sol-exempt-paths.md` and needs no fresh Sol review. Every exact-head gate still applies:
CodeRabbit APPROVED on the exact candidate head, every required check green on it, a head that contains
GitHub's real base, and a merge pinned to that head with `--match-head-commit`. The "after this PR" batch
then re-runs the helper with `--approved` set to the PR head that was merged (not the merge commit).

How the helper behaves:
- **It changes nothing on GitHub.** Its git and gh calls only read. The one local side effect is fetching
  `main` and PR #901's head into this PC's remote-tracking refs.
- **It prints every command that changes GitHub;** the operating session runs each one itself, in plain
  text, so every change is visible in the session. The tag push is an ordinary `git push`, so the pre-push
  hook runs on it. **No local hook inspects the `updateRefs` deletes** (`KNOWN_ISSUES.md`, "Local hooks do
  not inspect GitHub GraphQL ref updates"). What guards each delete is: the helper's `check` immediately
  before it; GitHub's compare-and-swap, which deletes only at the ledger commit; GitHub's server-side
  `protect-main` ruleset, which forbids deleting `main`; and Mason's yes for that batch.
- **It reads the ledger only from the commit Mason approves** (`--approved`). It accepts that ledger only
  if it has exactly 157, 16 and 0 rows, no duplicates, safe names, and restore sources in the expected
  form.
- **Any doubt is a refusal:** a failed lookup, unreadable output, or an unexpected error.

**A. Gates run before EVERY check, not just once per batch.** The helper's `plan`, `verify-tags` and every
per-branch `check` all re-run every gate below. A command printed earlier cannot act on a state that has
since changed. Any failure refuses the whole batch for re-review; the helper never quietly drops some
branches and continues.
1. **Mason's yes** for that batch, in the conversation. This is the operating session's duty; the script
   cannot see the chat.
2. **Right repository.** `origin`'s fetch and push addresses are `github.com/masonwells1/CRX_Manager_V1.0`,
   and GitHub's live ID for that repository equals the ID used in the delete command.
3. **The approved ledger is the published one.** The ledger at PR #901's live head (or on `main` after the
   merge) is byte-for-byte the ledger at the approved commit.
4. **For the 16 "after this PR" rows, all of the following:**
   - PR #901 merged at exactly the approved commit;
   - every file this PR rescues is byte-for-byte identical in the merge commit and the approved commit;
   - CodeRabbit's latest verdict is APPROVED on that exact commit;
   - each of `main`'s required checks (Vercel; Lint, Type Check, Test, Build; SQL Migration Validation) is
     green there, and no check run on that commit is failing or unfinished;
   - each branch's rescued record (a fixed text marker per branch) is still on `main`.
5. **Nothing relevant moved since review:**
   - the `protect-main` rules are identical, types and parameters, to the reviewed snapshot;
   - the lines naming each batch branch in `KNOWN_ISSUES.md`, `DECISION_LOG.md`, `CURRENT_STATE.md`,
     `TODO.md`, `AGENTS.md` and `CLAUDE.md` are unchanged from the reviewed state;
   - `main` has not changed, since the reviewed state, any file the branch also changes. PR #901's own
     reviewed edits do not count as a change.
6. **Preservation.** Every restore source matches on GitHub:
   - each `refs/pull/N/head`;
   - section1's existing tag;
   - after step B, every new archive tag.

   The local bundle's SHA-256 matches and `git bundle verify` passes.

**B. Archive tags, before any delete.** One ordinary `git push` creates the "to create" tags, so the
pre-push hook runs. The helper's `verify-tags` then reads every restore source back from GitHub.

**C. Per branch, immediately before its delete** (`check`). After all of A, the helper REFUSES the branch
if:
- it is not a row of this batch in the approved ledger, or is `main`;
- the session list is missing, malformed, or more than 30 minutes old;
- its live tip is not the ledger commit, or it is already gone;
- an open PR uses it as head or base;
- a worktree on this PC has it checked out or sits at its commit;
- an active agent session is on it, or has a working folder that resolves to it.

Only after `OK` does the printed GitHub `updateRefs` call run. It deletes `refs/heads/<branch>` only if the
branch still points at the ledger commit, so a commit pushed in the meantime makes GitHub refuse and
nothing is lost. Then `confirm` checks the branch is gone. Each printed line chains these with `&&`. **The
first branch of a batch runs alone as a canary,** and GitHub's reply is read back before any other branch.
This is the first real use of `updateRefs` in this repository.

**D. Failure handling.** If GitHub or a guard refuses a call, or any result is unknown:
- stop the batch;
- re-read the affected refs;
- reconcile, and record what actually happened.

Never retry blindly or switch routes without telling Mason. A permission prompt from the desktop app is
shown to Mason, never answered by the agent.

**E. After the batch** (`sweep`, given the batch start time as ISO-8601 UTC):
1. **Per ref:** every target is absent. A target still present, even at its own commit, is reported, as is
   any broken restore source.
2. **Adoption:** any target that became the head or base of a new or open PR, or is in use by a worktree
   or session, is reported, with a create-if-absent restore command. GitHub refuses that restore if the
   name exists, so nothing is overwritten; `confirm-restore` then reads the branch back at its ledger
   commit.
3. **Record outcomes:** the actual outcome of every row goes in a follow-up docs change.

**The residual Mason is asked to accept, stated exactly.** The helper sees PRs on GitHub, worktrees on this
PC, and the Claude desktop sessions in a list it requires to be under 30 minutes old. It cannot see a Codex
session, a separate clone or another computer that checks a branch out. It also cannot see a session that
picks a branch up and drops it again between checks. If one of those happens:
- **No commit is lost.** The delete succeeds only at the ledger commit, which stays on GitHub as a PR ref or
  tag and in the local bundle. That person's local copy is untouched.
- **The cost is small.** At worst, their next push of that branch recreates it, or a PR they opened closes
  and must be reopened with GitHub's Restore button.

Every target has had no open PR and no new commit since 2026-10-09 at the latest.

**What Mason's approval can and cannot cover.**
- **It can** accept a documented residual of this cleanup, like the one above.
- **It cannot** waive a merge or delivery gate, accept an open BLOCKER, or accept a HIGH finding that names
  a missing control. Those are fixed before deletion, never accepted.

## Restoring a branch

Each row gives the branch name, its exact commit, and where that commit lives:
- **A PR number:** GitHub's *Restore branch* button on that PR page. If the button is gone, fetch
  `refs/pull/<N>/head` and create a branch at the recorded commit.
- **A tag:** create a branch at that tag.

**Independent fallback, not dependent on GitHub keeping PR refs.** A git bundle of all 185 candidate branch
tips is at `C:/Users/mason/CRX_branch_archive/2026-10-13-github-branch-cleanup.bundle`, with a manifest
beside it.
- **What restoring needs.** It omits `main`'s history, so restoring needs a repository that already has the
  197 prerequisite commits `git bundle verify` lists. All are commits on `main` as of `7abd52f6d`, so any
  full clone of this repository qualifies; a shallow clone may not.
- **Restore proved independently on 2026-10-13.**
  - In a brand-new empty repository given only `main` at `7abd52f6d` from GitHub, a sample branch commit
    was confirmed absent beforehand.
  - The bundle verified.
  - All 185 refs were fetched from the bundle, each equal to its ledger commit.
  - `git fsck --connectivity-only` passed.
  - All 18,000 objects the branches need beyond `main` were present, none missing.
- **Where it lives.** Only on this PC, so it is a second copy, not an offsite one.

Like the earlier ledgers, this file deliberately carries no copy-paste shell command.

## Restore ledger: branches to delete (173)

### Job-to-invoice transfer retries (PR #638 lineage) (22)

| Branch | Commit | PR | Restore from | When |
|---|---|---|---|---|
| `claude/pr638-delivery-20260913` | `392415f64953dfe8f197616acaad6bf001701ad8` | #663 closed | PR #663 | after yes |
| `claude/pr638-delivery10-20260915` | `db936cfddb4cddff32d1db429a646519411a84c5` | #707 closed | PR #707 | after yes |
| `claude/pr638-delivery11-20260915` | `742f70f5c8b4440bff04371169e3f05a940d8076` | #708 closed | PR #708 | after yes |
| `claude/pr638-delivery12-20260917` | `543b2dd089a596815aa89526688f4f30ee566589` | #709 closed | PR #709 | after yes |
| `claude/pr638-delivery13-20260917` | `543b2dd089a596815aa89526688f4f30ee566589` | #712 closed | PR #712 | after yes |
| `claude/pr638-delivery14-20260917` | `10e272513567b7b5441ef0631d729fbbec84e410` | #713 closed | PR #713 | after yes |
| `claude/pr638-delivery15-20260918` | `353b0ef8613abe0aac4928bc83a7fd28ce3dbb68` | #715 closed | PR #715 | after yes |
| `claude/pr638-delivery16-20260918` | `ef03cd5439db80ee15492b7927ca27ed041c5208` | #717 closed | PR #717 | after yes |
| `claude/pr638-delivery17-20260918` | `55e56bf7641dbf662d98e27e0c988657dd40c657` | #719 closed | PR #719 | after yes |
| `claude/pr638-delivery18-20260918` | `862d308b9fa617b6a8ec171c8710954567b37c0f` | #720 closed | PR #720 | after yes |
| `claude/pr638-delivery2-20260913` | `e00f5870f90542c0310dbeeb2be4001308326aef` | #668 closed | PR #668 | after yes |
| `claude/pr638-delivery3-20260914` | `9ea5e7b3e74ee60c0a53b1eb93a84500206899be` | #684 closed | PR #684 | after yes |
| `claude/pr638-delivery4-20260914` | `8b587e76ec3aaa0a0bd7c49b777aa075cdbc212b` | #687 closed | PR #687 | after yes |
| `claude/pr638-delivery5-20260914` | `1fcbaabf096d06df36effbd7e5c46b2bfb529fb1` | #690 closed | PR #690 | after yes |
| `claude/pr638-delivery6-20260914` | `b1f0055b2a39a9741db9df765a6e2e044bd821f5` | #696 closed | PR #696 | after yes |
| `claude/pr638-delivery7-20260914` | `e1cf6902d39cc2c7bffdc1e189b0d4bf12e359d9` | #697 closed | PR #697 | after yes |
| `claude/pr638-delivery8-20260914` | `39af0526b79f41740d20e90d6de2d8cc3ef8fda1` | #698 closed | PR #698 | after yes |
| `claude/pr638-delivery9-20260914` | `7f621efce63c8b43f782c09689ed3ad4fe797bbc` | #699 closed | PR #699 | after yes |
| `claude/transfer-intent-explicit-legacy-overload-drop` | `47a5aee224d9df5eaa7c3e991f5b28533f629032` | #753 closed | PR #753 | after yes |
| `claude/transfer-legacy-overload-refused-by-name` | `47a5aee224d9df5eaa7c3e991f5b28533f629032` | #755 closed | PR #755 | after yes |
| `claude/transfer-legacy-overload-refused-by-name-r2` | `16d5bb1f15a58a20162bcb4671dd8ea79cb0796a` | #756 closed | PR #756 | after yes |
| `codex/commission-transfer-idempotency-fix-20260908` | `45e3fc2bc5df01099111530f66a5f23325299a1e` | #638 closed | PR #638 | after yes |

### Field-application filed-season guard — Claude laps (17)

| Branch | Commit | PR | Restore from | When |
|---|---|---|---|---|
| `claude/field-invoice-filed-season-20260920` | `dbd3fb333eba20ab36d64f208c1b9daaaa336672` | #731 closed | PR #731 | after yes |
| `claude/field-season-delivery-final-20260920` | `4920df8e44a1da683a224b6827a594a9aba87425` | #748 closed | PR #748 | after yes |
| `claude/field-season-delivery-lap10-20260922` | `920b4eb8373fa5bec25ae072a68de2fdcfca73d6` | #774 closed | PR #774 | after yes |
| `claude/field-season-delivery-lap11-20260923` | `acc33bc04acbaa45733f158360414f7484041cba` | #781 closed | PR #781 | after yes |
| `claude/field-season-delivery-lap12-20260923` | `925d2929314679c59bd7020a9539e906e9f1fd65` | #793 closed | PR #793 | after yes |
| `claude/field-season-delivery-lap13-20260927` | `7cfa4b495974e0632c03cd5d4eccdf57f8f81e09` | #828 closed | PR #828 | after yes |
| `claude/field-season-delivery-lap14-20260927` | `1f96c388e4cb2313cb92ff49abb897e6d4d31472` | #829 closed | PR #829 | after yes |
| `claude/field-season-delivery-lap15-20260927` | `0b63d7f2d931254c588c8981fa06b7e45ff3641a` | #832 closed | PR #832 | after yes |
| `claude/field-season-delivery-lap16-20260928` | `669e4c9b93e731a0ed7409841beb7ee207b2f01d` | #837 closed | PR #837 | after yes |
| `claude/field-season-delivery-lap17-20260928` | `89a9898c7a2958321c9123c79716ce21e79afbe4` | #838 closed | PR #838 | after yes |
| `claude/field-season-delivery-lap18-20260928` | `188e09e14cd97f2e41ae897ab7c88402975bfbb8` | #842 closed | PR #842 | after yes |
| `claude/field-season-delivery-lap19-20260928` | `a3acffc80f5d0c8bb946b5e66e85bb059f7f00f8` | #843 closed | PR #843 | after yes |
| `claude/field-season-delivery-lap6-20260920` | `13e89a3b864e1dee4236e22cbcda30df21e58e64` | #751 closed | PR #751 | after yes |
| `claude/field-season-delivery-lap7-20260921` | `068be7bfafdd54a9fb4cf5cbeef7de4e0c15e235` | #754 closed | PR #754 | after yes |
| `claude/field-season-delivery-lap8-20260921` | `9eb9348472aee4fc1a1347a0558ce5695d1869b0` | #758 closed | PR #758 | after yes |
| `claude/field-season-delivery-lap9-20260921` | `50ba943d65b74cbe9a35fc056e4fa0f1ac26b46c` | #762 closed | PR #762 | after yes |
| `claude/pr700-field-season-delivery-20260920` | `fe13e961b6f570f05d4115224bdccdc655f78772` | #742 closed | PR #742 | after yes |

### Inventory retries — PR #624 Codex laps (15)

| Branch | Commit | PR | Restore from | When |
|---|---|---|---|---|
| `codex/pr624-acknowledgment-read-cleanup-20260913` | `b5357ce6450175cffe684ee1aa64a8fbb98e285c` | #679 closed | PR #679 | after yes |
| `codex/pr624-acknowledgment-write-dedup-20260913` | `66a3907dedac8b79c9b489d7ff4ae010293d6a3d` | #678 closed | PR #678 | after yes |
| `codex/pr624-batch-retry-integration-20260913` | `033921841a3c80c86016e5c043209b82234f0dad` | #689 closed | PR #689 | after yes |
| `codex/pr624-confirmed-receiving-20260913` | `52556142da940b7c08aeb79ab7532a9b3b8a780d` | #674 closed | PR #674 | after yes |
| `codex/pr624-coverage-contracts-20260913` | `6e55c727bfbbfa6c246d5d4858a209d103971242` | #675 closed | PR #675 | after yes |
| `codex/pr624-current-main-delivery-20260913` | `043413b2edfb59998fffd1dbe724f96eeb756e20` | #683 closed | PR #683 | after yes |
| `codex/pr624-final-candidate-20260913` | `0b87a742ce2a2101fed55a890b6f49086b66f3d4` | #665 closed | PR #665 | after yes |
| `codex/pr624-final-review-corrections-20260913` | `0579a688153146bacf49810923d1c6613d6ff99d` | #680 closed | PR #680 | after yes |
| `codex/pr624-final-review-fixes-20260913` | `f7da37d579d1b48e43f3daf06a711b7022f1beae` | #676 closed | PR #676 | after yes |
| `codex/pr624-opus-reconciliation-20260913` | `e69874c466e2372769fa0180afd377f4b182f914` | #673 closed | PR #673 | after yes |
| `codex/pr624-peer-acknowledgment-retention-20260913` | `2ce8c1217015a8d177847c740e452f21c44b56c8` | #685 closed | PR #685 | after yes |
| `codex/pr624-peer-claim-override-reconciliation-20260913` | `934615fcee73c9d4d73f7770a3466ea4830b15e4` | #681 closed | PR #681 | after yes |
| `codex/pr624-receipt-proof-fix-20260913` | `908940b51d5ec572ee0f84e706a27d69434c8d4d` | #671 closed | PR #671 | after yes |
| `codex/pr624-retry-preparation-warnings-20260913` | `f83acc19b8fca5cfd253fc5c6d4882f55985b3bd` | #677 closed | PR #677 | after yes |
| `codex/pr624-staging-error-fix-20260913` | `dbd812a0ff6a829955fd2de8336a2f7bb1ab476b` | #667 closed | PR #667 | after yes |

### Docs cleanup part 1 laps (12)

| Branch | Commit | PR | Restore from | When |
|---|---|---|---|---|
| `claude/docs-cleanup-1-corrections` | `c86c7685fd3bcb1bb438fe9c2964aa980aa5f87f` | #809 closed | PR #809 | after yes |
| `claude/docs-cleanup-1-corrections-v10` | `ac3249ded5116fdb9945971c8c560b0974bc269f` | #818 closed | PR #818 | after yes |
| `claude/docs-cleanup-1-corrections-v11` | `86db976001f7637bdc2f7c3dec7dd237623611f9` | #819 closed | PR #819 | after yes |
| `claude/docs-cleanup-1-corrections-v12` | `697d73dd74773ffbf34899521864ed4d46f1a9c4` | #821 closed | PR #821 | after yes |
| `claude/docs-cleanup-1-corrections-v2` | `c86c7685fd3bcb1bb438fe9c2964aa980aa5f87f` | #810 closed | PR #810 | after yes |
| `claude/docs-cleanup-1-corrections-v3` | `cc763fb6873d26bd8cbc4a563afdb4b7caa304ab` | #811 closed | PR #811 | after yes |
| `claude/docs-cleanup-1-corrections-v4` | `aeeb630c4afa4a2a5f432aae2091e696952c260d` | #812 closed | PR #812 | after yes |
| `claude/docs-cleanup-1-corrections-v5` | `a1bc9881856698546ca2b442dc32774ea3c15e9b` | #813 closed | PR #813 | after yes |
| `claude/docs-cleanup-1-corrections-v6` | `24182a0c3b70f9425419fafe9d96691a512e16b8` | #814 closed | PR #814 | after yes |
| `claude/docs-cleanup-1-corrections-v7` | `8123df326665af50330264e4518cddfddff3a6a2` | #815 closed | PR #815 | after yes |
| `claude/docs-cleanup-1-corrections-v8` | `47632834aaf8d75c7d498cc9147a74f93f41cc9c` | #816 closed | PR #816 | after yes |
| `claude/docs-cleanup-1-corrections-v9` | `39c3bc6fb6bfa65ea4fa35eaea6c40f42eaaacbb` | #817 closed | PR #817 | after yes |

### Migration bookkeeping (12)

| Branch | Commit | PR | Restore from | When |
|---|---|---|---|---|
| `chore/migration-ledger-reconcile-20260729` | `65716b1c2d910b4d1ebf995eba6302926e1f8efc` | #275 closed | PR #275 | after yes |
| `claude/617-applied-live-docs` | `c787dca8c58093e9d58609c69b6c0340a360a5aa` | #729 closed | PR #729 | after yes |
| `claude/617-applied-live-docs-v2` | `4d7540684450e828d1cff16b9d23aa58cd79d49b` | #733 closed | PR #733 | after yes |
| `claude/comment-fix-applied-closeout` | `01660702bca67d42908a98f968e80207fb6b025f` | #501 closed | PR #501 | after yes |
| `claude/recover-applied-migrations-20260812` | `27817c2a532993c92be36e0c9f63905f50aa3256` | #395 closed | PR #395 | after this PR |
| `claude/refresh-schema-registry-after-restamp` | `3d199a5b668007c213279a09ad8e16d09a4859d2` | #710 closed | PR #710 | after yes |
| `claude/restamp-stranded-20260905-migrations` | `230f32baff6a3e75ee7654669b0f89ac26157bbe` | #688 closed | PR #688 | after yes |
| `claude/restamp-stranded-20260905-migrations-delivery-2` | `5826926fc90f898d9dd1ea5e588722f36751cc34` | #695 closed | PR #695 | after yes |
| `claude/restamp-stranded-20260905-migrations-delivery-3` | `aa4c4abf14d854cf300ef04707d5af563d8685c3` | #701 closed | PR #701 | after yes |
| `claude/restamp-stranded-20260905-migrations-delivery-4` | `aa4c4abf14d854cf300ef04707d5af563d8685c3` | #702 closed | PR #702 | after yes |
| `claude/restamp-stranded-20260905-migrations-delivery-5` | `ec0af0d84a1acd17ab2ede6cdcf67c304dec22f6` | #703 closed | PR #703 | after yes |
| `claude/schema-registry-refresh-20260905` | `dd212907206896976192919e46990528eb7ace2d` | #602 closed | PR #602 | after yes |

### CodeRabbit and merge-gate attempts (10)

| Branch | Commit | PR | Restore from | When |
|---|---|---|---|---|
| `claude/approval-head-binding-20260902` | `53e9c07142a4428848a3cebc0c31d2c1b83334c9` | #556 closed | PR #556 | after yes |
| `claude/close-superseded-delivery-prs-20260914` | `133d10f25c8cb2c20e5a8951e3e019feb0dd5c24` | #705 closed | PR #705 | after yes |
| `claude/coderabbit-request-path-guard-text` | `834fdf976d9f6faf1de31603c1dd3ab21182cbbd` | #634 closed | PR #634 | after yes |
| `claude/coderabbit-review-gate-b9f43a` | `a4483886fd8d958cc4afb36926c18c0fb66b107c` | #569 closed | PR #569 | after yes |
| `claude/coderabbit-setup-optimize-0f308d` | `5b58e3524aa4773c8f6d49cce73bfd57f1165789` | #441 closed | PR #441 | after yes |
| `claude/sol-skip-policy-proposal` | `c264695f0a8a50a369794cb0c65ac7feff1984b4` | #870 closed | PR #870 | after yes |
| `codex/coderabbit-execution-context-20260913` | `feb925977fb1ee7bb10da81739640496d7aa790d` | #656 closed | PR #656 | after yes |
| `codex/coderabbit-native-landing-20260913` | `e8527796971d13e1bc3e356349bda6ddf04820a1` | #654 closed | PR #654 | after yes |
| `codex/coderabbit-native-request-20260909` | `27531bf188fc6db3ab6726f0b28f362b4985e4d3` | #647 closed | PR #647 | after yes |
| `codex/coderabbit-snapshot-retry-20260913` | `e3f9d006fd64fe483909a39eb5b467d3a8cc7e86` | #655 closed | PR #655 | after yes |

### adjust_inventory receipt binding (11)

| Branch | Commit | PR | Restore from | When |
|---|---|---|---|---|
| `claude/bind-adjust-inventory-receipt` | `76e2ae4071fd17b01561ebdf69b21b5c7d629dbc` | #664 closed | PR #664 | after yes |
| `claude/bind-adjust-inventory-receipt-delivery-20260917` | `96508921571f883ab2de6d53e1622ca12deb7755` | #711 closed | PR #711 | after this PR |
| `claude/bind-adjust-inventory-receipt-delivery-20260917-10` | `e7adccc8b860d103f8fe89ee6b4f6d6061949cf4` | #738 closed | PR #738 | after yes |
| `claude/bind-adjust-inventory-receipt-delivery-20260917-2` | `96508921571f883ab2de6d53e1622ca12deb7755` | #714 closed | PR #714 | after yes |
| `claude/bind-adjust-inventory-receipt-delivery-20260917-3` | `ed017afc7263871ef6cb74a340d2b5e24c7471ff` | #716 closed | PR #716 | after yes |
| `claude/bind-adjust-inventory-receipt-delivery-20260917-4` | `5a837a1de13b3b792dce7651efc3f8cd6e9b004e` | #718 closed | PR #718 | after yes |
| `claude/bind-adjust-inventory-receipt-delivery-20260917-5` | `2939083b633ad8138104b800a79a9e048f0af422` | #723 closed | tag archive/2026-10-13/claude/bind-adjust-inventory-receipt-delivery-20260917-5 (exists) | after yes |
| `claude/bind-adjust-inventory-receipt-delivery-20260917-6` | `b0d6236bb6208b65336bda945ee619d4e82b26b3` | #727 closed | PR #727 | after yes |
| `claude/bind-adjust-inventory-receipt-delivery-20260917-7` | `6eca0d786edd6c4155cc61f2ebe62d4fcad99c92` | #732 closed | PR #732 | after yes |
| `claude/bind-adjust-inventory-receipt-delivery-20260917-8` | `ca68bb3df9435a074e51c7706938ab1c9b593a20` | #735 closed | PR #735 | after yes |
| `claude/bind-adjust-inventory-receipt-delivery-20260917-9` | `22ae064a11452b8e6345975e4604851eac6e2ad5` | #737 closed | PR #737 | after yes |

### Customer documents (9)

| Branch | Commit | PR | Restore from | When |
|---|---|---|---|---|
| `claude/crx-soft-delete-download-revoke-50befc` | `66fec5a379638ceffa170f1f5371f75858d71f5c` | #759 closed | PR #759 | after yes |
| `claude/crx-soft-delete-download-revoke-v2` | `ecb4055dbe200c050b5dd6f1a890fcb6b03dbd47` | #760 closed | PR #760 | after yes |
| `claude/crx-soft-delete-download-revoke-v3` | `d8c30f7394183d1a73614de7b0b0f7397fe4b989` | #761 closed | PR #761 | after yes |
| `claude/crx-soft-delete-download-revoke-v4` | `470a3f37508f3d31cc49c10f4a6734b76f95f927` | #763 closed | PR #763 | after yes |
| `claude/customer-document-rep-remove-page` | `fda25d4a691f0a2ce6259102834b68097291ebb9` | no PR | tag archive/2026-10-13/claude/customer-document-rep-remove-page (to create) | after this PR |
| `claude/customer-document-rep-remove-page-v2` | `aee5c0c1f4b8e301438cc852a5566519f977281f` | no PR | tag archive/2026-10-13/claude/customer-document-rep-remove-page-v2 (to create) | after this PR |
| `claude/customer-document-rep-remove-page-v3` | `812174bc0b02330c06b5727c1443f5a506d0ed25` | no PR | tag archive/2026-10-13/claude/customer-document-rep-remove-page-v3 (to create) | after this PR |
| `claude/customer-document-rep-soft-delete` | `bb3432e086a998c15d4033c02c3a436eb833b72e` | #769 closed | PR #769 | after yes |
| `codex/customer-document-soft-delete-20260908` | `a50130bfed7071307db8af2588592de00604afef` | #635 closed | PR #635 | after yes |

### Field-application filed-season guard — Codex laps, install docs, test fixes (9)

| Branch | Commit | PR | Restore from | When |
|---|---|---|---|---|
| `claude/field-season-install-20261001` | `14688aa8ffecd2646d36848696fc0dfd76e63263` | #862 closed | PR #862 | after yes |
| `claude/field-season-install-20261001b` | `edcf6d6e6b4f53702344880365377790b0b7404f` | #865 closed | PR #865 | after yes |
| `claude/fix-field-app-invoice-test-date` | `ab6eede1df10e37e5c9ac652086b36efaf9ab7a9` | #860 closed | PR #860 | after yes |
| `claude/fix-invoice-date-test-rollover` | `870d79ee0e3f31967cf6440a250b1ac67fecb64a` | #859 closed | PR #859 | after yes |
| `codex/field-app-current-main-20260914` | `dbd3fb333eba20ab36d64f208c1b9daaaa336672` | #700 closed | PR #700 | after yes |
| `codex/field-app-filed-season-guard-20260912` | `7a0ed406b1fec7459edea78243bbc0fddffde7a5` | #652 closed | PR #652 | after yes |
| `codex/field-app-season-final-20260913` | `e730b40b403044b1217870915a7e402e214e5c2d` | #660 closed | PR #660 | after yes |
| `codex/field-app-season-review-fixes-20260913` | `dd3ce212c884c20f575ed189225f0549e04a5894` | no PR | tag archive/2026-10-13/codex/field-app-season-review-fixes-20260913 (exists) | after yes |
| `codex/field-app-season-reviewed-20260913` | `5818d67aee18ae3a02d957a4359f859d4dedae0a` | #662 closed | PR #662 | after yes |

### Guard fixes (B) (8)

| Branch | Commit | PR | Restore from | When |
|---|---|---|---|---|
| `claude/actor-forgery-sweeps-20260902` | `c12c85ab8ec905ba8e6e162ffa61c7a312adfdd7` | #551 closed | PR #551 | after yes |
| `claude/push-guard-git-resolution` | `62d22b6e9de259f5c5653d7a0ebc5f911a779d10` | #445 closed | PR #445 | after yes |
| `claude/remove-guard-hooks-f23691` | `0ac235d0e50e106fb2c5e5df4dff46aad02144fa` | #503 closed | PR #503 | after yes |
| `claude/review-proof-guard-read-only-narrowing` | `e02709981a3ccabfd2991a41c32082fe5329525b` | #612 closed | PR #612 | after this PR |
| `claude/session-orchestration-setup-d73e6c` | `238d242ea87f789573e7642c9579c103909ac8a2` | #364 closed | PR #364 | after yes |
| `codex/pr402-review-gaps-20260819` | `8811927fff8d6a7d375a91b48be6be1ebb6d5781` | #432 closed | PR #432 | after yes |
| `codex/proof-wrapper-trusted-git-bootstrap` | `a2e1d0a183691964c2bdf9e2c5a38af33df24d69` | #454 closed | PR #454 | after yes |
| `codex/sol-gate-recovery-exception` | `9817fb9e058aef0732ef58fb033c5e9ca635bcc1` | #403 closed | PR #403 | after yes |

### Guard fixes (A) (8)

| Branch | Commit | PR | Restore from | When |
|---|---|---|---|---|
| `claude/bash-safety-opacity-cleanup` | `bf54a52c9114e803ef95cc5c9a4eee93ea02c507` | #527 closed | PR #527 | after this PR |
| `claude/codex-guard-single-ampersand` | `dddc6d74820a6f82e9a8cbdc54ede3838c4a3f76` | #464 closed | PR #464 | after yes |
| `claude/codex-recursion-hard-guard` | `47820dff7ed6f4fd85767f8a62d0e9f21880808e` | #452 closed | PR #452 | after yes |
| `claude/live-data-guard-comment-aware` | `b326461e0e9974bb185d6e1f578c592f6a6bcf1f` | #639 closed | PR #639 | after this PR |
| `claude/nested-guards-delivery-20260930` | `9704220f3b166f7252ecdce8d5045b6c408cd505` | #851 closed | PR #851 | after yes |
| `claude/peer-envelope-fence-504b` | `890b41dcb233ad8c3f45c6dd9d3e14d38388135a` | #768 closed | PR #768 | after yes |
| `claude/pr-630-adversarial-review-vrpl9r` | `e9e212fa395633ba0ff78d027e24ad12b91da8b3` | #795 closed | PR #795 | after yes |
| `fix/push-guard-binary-shape` | `81c70d7c81c4ff2def5445b0d1765e14fde5c173` | #626 closed | PR #626 | after yes |

### Docs cleanup — other (7)

| Branch | Commit | PR | Restore from | When |
|---|---|---|---|---|
| `claude/changelog-docs-honesty` | `cc8eed92c50815802d604fe0725b5a617d44ed3e` | #505 closed | PR #505 | after yes |
| `claude/docs-cleanup-3-remove-finished` | `50f11d9ec92c36d298d1ea7e1c01e81c28268cd1` | #835 closed | PR #835 | after yes |
| `claude/docs-cleanup-3-remove-finished-v2` | `2f9bee7c13dc688b8967c90d452e8163acce5c69` | #854 closed | PR #854 | after yes |
| `claude/docs-cleanup-fix-stale-facts` | `98f60e6d0ff719223d3ed164bffe2c98a15b9f01` | #807 closed | PR #807 | after yes |
| `claude/docs-review-best-practices-trv6qq` | `fbbe6fd311d37d6f6285667cb0e404762eb48f77` | #836 closed | PR #836 | after yes |
| `claude/repo-docs-cleanup-101ef7` | `a3f58c5811c4b42095a2f35a7dc6721a6f5fe148` | #803 closed | PR #803 | after yes |
| `codex/lean-agent-docs-20260904` | `f1d2037df191d9a854b03257e07c0204d0126335` | #600 merged | tag archive/2026-10-13/codex/lean-agent-docs-20260904 (exists) | after yes |

### Inventory retries — other laps (7)

| Branch | Commit | PR | Restore from | When |
|---|---|---|---|---|
| `claude/inventory-hold-retry-delivery` | `492331008109dfb65af47fe95d669fb0ca465138` | #666 closed | PR #666 | after yes |
| `claude/inventory-hold-retry-delivery-2` | `80531fb644cbe305f8dec0703c781d29f1cda98d` | #670 closed | PR #670 | after yes |
| `claude/inventory-hold-retry-delivery-3` | `08cc28a4131e637ec89cf3cd6f072a0f8cc45ea4` | #672 closed | PR #672 | after this PR |
| `claude/inventory-idempotency-key-reset-888161` | `b36de2ad887e66bc11c5fb8b78108dbce65d24d3` | #624 closed | PR #624 | after yes |
| `codex/inventory-ack-reload-delivery-20260913` | `66afc1cb043927e311e67c5a630d09508fb154db` | #661 closed | PR #661 | after yes |
| `codex/inventory-peer-ack-delivery-20260913` | `86b9ecb3a3f92831be9968e51d2c9a716fb45c93` | #659 closed | PR #659 | after yes |
| `codex/inventory-retry-native-delivery-20260913` | `f7b7bfc6b74d5af7b7ff16e9ddb11afa504e5b48` | #658 closed | PR #658 | after yes |

### Money and security one-offs (6)

| Branch | Commit | PR | Restore from | When |
|---|---|---|---|---|
| `codex/harden-actor-binding-sql-reader` | `e652f7232da2b16b10d5e770b919d969337488d4` | #373 closed | PR #373 | after yes |
| `codex/idempotency-reset-order-hardening-20260802` | `9049efc80e3e9cf8956b32061fab0688487a8758` | no PR | tag archive/2026-10-13/codex/idempotency-reset-order-hardening-20260802 (to create) | after this PR |
| `codex/pr-comment-remediation-20260903` | `5dbad8a3fa76f2ae1a8a86a9bf9ab7108a260def` | #591 closed | PR #591 | after this PR |
| `codex/section1-security-hardening-20260725` | `53f6177eb6afe628c5de437ac27f4a9cd8fbb7cf` | no PR | tag preserve/2026-07-29/codex-section1-security-hardening-20260725 (exists) | after this PR |
| `codex/section4-lifecycle-20260805` | `99cfcff5825ea9598eeb59d4f07a057e1e2e7379` | #321 closed | PR #321 | after yes |
| `codex/section9-ap-safety-remediation` | `0f8bf3aad7f0b6dea6632393402478cf85db6624` | #491 closed | PR #491 | after yes |

### Miscellaneous (6)

| Branch | Commit | PR | Restore from | When |
|---|---|---|---|---|
| `claude/bulk-import-retry-scopes` | `ed62508e2937457a3ff58658b76d95525983320a` | no PR | tag archive/2026-10-13/claude/bulk-import-retry-scopes (to create) | after this PR |
| `claude/pr611-land-20260905` | `231ad9cdde4b137aa36eedb88cd6c75f3e25fbd7` | no PR | tag archive/2026-10-13/claude/pr611-land-20260905 (exists) | after yes |
| `fix/quote-fixture-stale-date` | `be5df11c5dafce08f69bec0e9c4ad079122d24eb` | #468 closed | PR #468 | after yes |
| `ops/integrity-report-2026-09-01` | `a9dad49cb2a135cc7a3ac5c7fd6827d93922cc85` | #539 closed | PR #539 | after yes |
| `ops/integrity-report-2026-10-01` | `fa748a0fdc8a4d17e42e2ca0916fc3fec4d35f45` | #861 closed | PR #861 | after yes |
| `preserve/crx-manager-uncommitted-archive-20260908` | `5dcdb853e4bcf5101fa4966fface8ce64cf0dbc5` | no PR | tag archive/2026-10-13/preserve/crx-manager-uncommitted-archive-20260908 (exists) | after yes |

### Pricing and return-credit (August) (5)

| Branch | Commit | PR | Restore from | When |
|---|---|---|---|---|
| `claude/codex-claude-cogs-handoff-7bde15` | `e3c4a3fc47df9c8c9eabe3e35452482a5775ff64` | no PR | tag archive/2026-10-13/claude/codex-claude-cogs-handoff-7bde15 (exists) | after yes |
| `claude/ordering-cycle-review-t41vat` | `992ee08881768f008ef0e51dac22972ed531615f` | #363 closed | PR #363 | after yes |
| `claude/product-plan-rev12-followup` | `74ccba0f7888e69050d4951be9df02de2de25d68` | #507 closed | PR #507 | after this PR |
| `claude/return-credit-cogs-reversal` | `c4e83dea632b37b02e8b14e64c2859b7668f0e77` | #361 closed | PR #361 | after yes |
| `codex/defer-return-credit-rollout-20260831` | `ac695f4993effb3f2dafb2a77acf85e6670b2d74` | #532 closed | PR #532 | after this PR |

### Permissions and owner approval (5)

| Branch | Commit | PR | Restore from | When |
|---|---|---|---|---|
| `claude/gallant-jackson-b07f96` | `d8a6fdbcdfbccae4753ef498755080f40e5399d1` | #822 closed | PR #822 | after yes |
| `claude/loosen-claude-permissions-20260905` | `d5cc21353ef0229fea6b57f8dd62b6175ab6c091` | #605 closed | PR #605 | after this PR |
| `claude/owner-approval-route-20260929` | `fd52fb46177061b1c4e64011c8d8f9b95be8c9d9` | #845 closed | PR #845 | after yes |
| `claude/owner-approval-route-20260930` | `c9849dacc314d2c70323bf9dbff91dd8b6cf9293` | #853 closed | PR #853 | after yes |
| `codex/autonomy-with-hard-boundaries-20260827` | `3accebbef6abfe2327188a6fb6ebabae2a5f518e` | #513 closed | PR #513 | after yes |

### Dependency advisories (4)

| Branch | Commit | PR | Restore from | When |
|---|---|---|---|---|
| `claude/brace-expansion-audit-fix` | `8cbe2478b03da53e977694a0ce99589c1b1e5de3` | #848 closed | PR #848 | after yes |
| `claude/deps-audit-fix-20260930` | `1f7449f79cca5f5492a8d64f5e0b1436eda79a92` | #846 closed | PR #846 | after yes |
| `claude/deps-audit-fix-20260930-v2` | `1f7449f79cca5f5492a8d64f5e0b1436eda79a92` | #849 closed | PR #849 | after yes |
| `claude/js-yaml-high-advisory-20260908` | `cf28a8601d5da6d4b6c434b7d2c4179298afe406` | #644 closed | PR #644 | after yes |
