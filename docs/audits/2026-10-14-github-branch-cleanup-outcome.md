# GitHub branch cleanup: outcome record (2026-10-14)

This file records what actually happened in the GitHub branch cleanup planned in
`docs/audits/2026-10-13-github-branch-cleanup-audit.md` (PR #901). That file stays the restore ledger and
is deliberately left unchanged: the deletion helper requires the ledger on `main` to be byte-for-byte the
ledger at the approved PR #901 head, so anything that happened afterwards is recorded here instead.

## Status

- **157 "after yes" rows: DELETED 2026-10-14.** Mason approved the batch in the operating conversation
  ("yes delete the 157"). The helper's sweep reported all 157 gone with every restore source intact. Each
  row is listed below and was re-verified live when this file was written: the branch is absent and its
  restore source (PR ref or archive tag) still points at the ledger commit.
- **16 "after this PR" rows: DELETED 2026-10-15 (02:51-02:55 UTC).** Mason approved them ("yes delete
  the 16", 2026-10-14) in the same conversation, and they ran with helper version 3 below. This record was
  first meant to merge before them, but other pull requests kept landing on `main` faster than it could be
  re-reviewed, so Mason chose to delete first and record after ("Flip it"). The helper does not depend on
  this record: its gates use PR #901 and a fresh re-measure. Each row is listed below and was re-verified
  live: the branch is absent and its restore source still points at the ledger commit.
- **12 kept branches: unchanged** at the commits in the ledger, checked live after the 157 and again after
  the 16. 15 branches remain on GitHub: `main`, the 12 kept branches,
  `claude/invoicing-admin-only-db-20261010` (never in scope), and this record's own branch.

## Helper version 3 (supersedes the ledger's recorded helper hash)

The ledger records helper version 2 (`e80f52bf633c09edd6ced6956ab7629683c1eadd0ebc25029175befe38621988`) and
says a different file must not run. This section records the replacement, which is the only version that
may run the remaining batch:

- **helper v3:** `53e250ca48eb05d2e1de0a79905b6146a0bffaecc8e7163532565a5e972a0574`
  (`C:/Users/mason/CRX_branch_archive/branch-cleanup-2026-10-13.mjs`; v2 kept beside it as
  `branch-cleanup-2026-10-13.v2-e80f52bf.mjs`)
- **baseline used for the 16:** `f5cc7f151050e87f63f4090fca530734fca9dd0c932b6245431adfe68ae78a43`,
  measured at `main` `fa086edc6` (PR #918's merge); earlier baselines are kept beside it as
  `.at-<commit>.json`, including `b64e7097c0b6065e0945836df1ad22c40e79bf5e073830be54e43e1ac1cfa921` at
  `76b1227d1` (PR #920's merge), `920b7b3eb3ec62d34459aaf29e4360c40ae5c1d2ad909a398cbff73946d83bd3` at `133416234` (PR #913's merge),
  `8967eb601e6c572a80efb612b60f4d86ac4b8d308b616823aba12a887eecac11` at `ab3600c9f` (PR #917's merge) and
  `4e26e807fd67897e2ef053799759d4468127049ae8f91be7ca0f18485d2caef4` at `641a62a5f` (PR #901's merge)
- **bundle:** unchanged, `dd0a305b3531e418d5a5ab4633c3c16b08dab41c35ff28536f08e997faf98b1d`

**Re-measured after PR #917.** PR #917 (a pricing-plan document follow-up) landed on `main` after PR #901
and changed `TODO.md` and two pricing-plan files. Every branch was re-measured at `ab3600c9f` with the
audit's method: all 185 match the previous baseline exactly, no branch gains an unlanded path, and no
watched-document line naming any branch changed. The baseline was therefore rewritten at `ab3600c9f` with
no branch entry changed (`8967eb60…`).

**Re-measured after PRs #921 and #913.** Both then landed on `main` (database and smoke-test
documentation). They edit shared manual files that 11 of the 16 also edit, so every branch was re-measured
at `133416234`: 184 of 185 match, including all 16 and all 12 kept branches, no watched-document line
naming any branch changed, and all 22 rescue markers are present. The one difference is `claude/docs-cleanup-1-corrections-v12`, already deleted in the 157 (restore source
PR #821 intact): it now also counts `docs/reference/database-schema.md` as unlanded only because #921
edited `main`'s copy of that file. Because this is a branch gaining an unlanded path, the rewrite stopped
for Mason, who accepted it ("Accept", 2026-10-14). The baseline was rewritten at `133416234` with only that
entry changed (`920b7b3e…`).

**Re-measured after PR #920.** PR #920 (rule-page documentation) then landed on `main`. Every branch was
re-measured at `76b1227d1`: all 185 match, no watched-document line naming any branch changed, and all 22
rescue markers are present. The baseline was rewritten there with no branch entry changed
(`b64e7097…`, reported to Mason).

**Re-measured after PRs #923, #924, #925 and #918, then the batch.** Those four then landed (`main`
`fa086edc6`). Every branch was re-measured there: all 185 match, no watched-document line naming any branch
changed, and all 22 rescue markers are present; Mason was told the result before approving "Flip it". The
baseline was rewritten there with no branch entry changed (`f5cc7f15…`; this hash was reported to Mason
with the batch result, not before it). Then, with `main` still at `fa086edc6`:
- the helper's `plan` dry run exited 0 with 16 deletes, one push of 5 archive tags, and no kept branch,
  `main` or open-pull-request branch named; it matched the earlier dry run line for line;
- the 5 archive tags were pushed and `verify-tags` confirmed all 16 restore sources and the bundle;
- the first deletion ran alone as a canary, then the other 15 in three chunks, each line stopping at the
  first refusal; none refused;
- the `sweep` reported all 16 gone with every restore source intact, and all 12 kept branches were at their
  ledger commits.

**Why it changed.** PR #901 merged at exactly its approved head `64a7250dd` (CodeRabbit APPROVED, every
required check green), but GitHub squash-merged it onto a `main` that already held PR #910. #910 had edited
the "Last verified" headers of two rescued files, `KNOWN_ISSUES.md` and `CURRENT_STATE.md`. Helper v2
required each rescued file to be byte-identical in the merge commit and the approved head, so it refused
the 16, and it could never pass because the merge commit cannot change. Mason chose to change the check
("option 1") rather than keep the 16 branches.

**What changed, and only that.** In the docs gate, a rescued file that differs between the merge commit and
the approved head is now accepted only when the merged file is byte-for-byte the clean, conflict-free
three-way merge (`git merge-file`) of the approved file with `main`'s own changes since the PR last took
`main`. The check refuses on: more than one merge-base, a two-parent merge, a missing side, any conflict,
or any other difference. A failure to run the check reports "could not establish" (exit 3). Every other
gate is unchanged.

**Proof.**
- An independent read-only review of the v2 → v3 diff returned CLEAN (no BLOCKER or HIGH). It confirmed
  nothing else in the file changed. It re-ran the merge for both differing files with four diff
  algorithms, each matching the merge commit byte for byte. It found all seven rescued files valid UTF-8,
  and every rescue marker absent from the base and present in the merge commit. Its three hardening
  suggestions were applied: exactly one merge-base, byte comparison instead of decoded text, and exit 3
  for a failure to check.
- Seven direct tests of the new check against real commits all behaved as expected. The real merge
  passes for both files. Older #901 heads are refused, one through the conflict path. A file
  byte-identical at an older head passes, as a content-based rule should.
- `plan --batch after-docs --approved 64a7250ddca3ebbf20e361fc72855a4f3f79162a`: exit 0, 16 deletes, one
  push of 5 archive tags, and no kept branch, `main` or open-PR branch named.

**Baselines after `main` moved.** The review baseline was re-measured with the audit's own method and
rewritten each time `main` moved. The report lists each step up to `ca20e4757`; after it, the
re-measure at `641a62a5f` found 13 branches changed. Twelve were already deleted. The thirteenth,
`claude/product-plan-rev12-followup`, lost its unlanded paths because #901 put its plan revision on `main`,
which is the rescue working; no branch gained an unlanded path. Every deletion row that `main`'s watched
documents now name is named exactly as at the approved #901 head.

## Outcome of the 157 "after yes" rows

| Branch | Commit | Restore from | Outcome |
|---|---|---|---|
| `claude/pr638-delivery-20260913` | `392415f64` | PR #663 | Deleted 2026-10-14; restore source verified |
| `claude/pr638-delivery10-20260915` | `db936cfdd` | PR #707 | Deleted 2026-10-14; restore source verified |
| `claude/pr638-delivery11-20260915` | `742f70f5c` | PR #708 | Deleted 2026-10-14; restore source verified |
| `claude/pr638-delivery12-20260917` | `543b2dd08` | PR #709 | Deleted 2026-10-14; restore source verified |
| `claude/pr638-delivery13-20260917` | `543b2dd08` | PR #712 | Deleted 2026-10-14; restore source verified |
| `claude/pr638-delivery14-20260917` | `10e272513` | PR #713 | Deleted 2026-10-14; restore source verified |
| `claude/pr638-delivery15-20260918` | `353b0ef86` | PR #715 | Deleted 2026-10-14; restore source verified |
| `claude/pr638-delivery16-20260918` | `ef03cd543` | PR #717 | Deleted 2026-10-14; restore source verified |
| `claude/pr638-delivery17-20260918` | `55e56bf76` | PR #719 | Deleted 2026-10-14; restore source verified |
| `claude/pr638-delivery18-20260918` | `862d308b9` | PR #720 | Deleted 2026-10-14; restore source verified |
| `claude/pr638-delivery2-20260913` | `e00f5870f` | PR #668 | Deleted 2026-10-14; restore source verified |
| `claude/pr638-delivery3-20260914` | `9ea5e7b3e` | PR #684 | Deleted 2026-10-14; restore source verified |
| `claude/pr638-delivery4-20260914` | `8b587e76e` | PR #687 | Deleted 2026-10-14; restore source verified |
| `claude/pr638-delivery5-20260914` | `1fcbaabf0` | PR #690 | Deleted 2026-10-14; restore source verified |
| `claude/pr638-delivery6-20260914` | `b1f0055b2` | PR #696 | Deleted 2026-10-14; restore source verified |
| `claude/pr638-delivery7-20260914` | `e1cf6902d` | PR #697 | Deleted 2026-10-14; restore source verified |
| `claude/pr638-delivery8-20260914` | `39af0526b` | PR #698 | Deleted 2026-10-14; restore source verified |
| `claude/pr638-delivery9-20260914` | `7f621efce` | PR #699 | Deleted 2026-10-14; restore source verified |
| `claude/transfer-intent-explicit-legacy-overload-drop` | `47a5aee22` | PR #753 | Deleted 2026-10-14; restore source verified |
| `claude/transfer-legacy-overload-refused-by-name` | `47a5aee22` | PR #755 | Deleted 2026-10-14; restore source verified |
| `claude/transfer-legacy-overload-refused-by-name-r2` | `16d5bb1f1` | PR #756 | Deleted 2026-10-14; restore source verified |
| `codex/commission-transfer-idempotency-fix-20260908` | `45e3fc2bc` | PR #638 | Deleted 2026-10-14; restore source verified |
| `claude/field-invoice-filed-season-20260920` | `dbd3fb333` | PR #731 | Deleted 2026-10-14; restore source verified |
| `claude/field-season-delivery-final-20260920` | `4920df8e4` | PR #748 | Deleted 2026-10-14; restore source verified |
| `claude/field-season-delivery-lap10-20260922` | `920b4eb83` | PR #774 | Deleted 2026-10-14; restore source verified |
| `claude/field-season-delivery-lap11-20260923` | `acc33bc04` | PR #781 | Deleted 2026-10-14; restore source verified |
| `claude/field-season-delivery-lap12-20260923` | `925d29293` | PR #793 | Deleted 2026-10-14; restore source verified |
| `claude/field-season-delivery-lap13-20260927` | `7cfa4b495` | PR #828 | Deleted 2026-10-14; restore source verified |
| `claude/field-season-delivery-lap14-20260927` | `1f96c388e` | PR #829 | Deleted 2026-10-14; restore source verified |
| `claude/field-season-delivery-lap15-20260927` | `0b63d7f2d` | PR #832 | Deleted 2026-10-14; restore source verified |
| `claude/field-season-delivery-lap16-20260928` | `669e4c9b9` | PR #837 | Deleted 2026-10-14; restore source verified |
| `claude/field-season-delivery-lap17-20260928` | `89a9898c7` | PR #838 | Deleted 2026-10-14; restore source verified |
| `claude/field-season-delivery-lap18-20260928` | `188e09e14` | PR #842 | Deleted 2026-10-14; restore source verified |
| `claude/field-season-delivery-lap19-20260928` | `a3acffc80` | PR #843 | Deleted 2026-10-14; restore source verified |
| `claude/field-season-delivery-lap6-20260920` | `13e89a3b8` | PR #751 | Deleted 2026-10-14; restore source verified |
| `claude/field-season-delivery-lap7-20260921` | `068be7bfa` | PR #754 | Deleted 2026-10-14; restore source verified |
| `claude/field-season-delivery-lap8-20260921` | `9eb934847` | PR #758 | Deleted 2026-10-14; restore source verified |
| `claude/field-season-delivery-lap9-20260921` | `50ba943d6` | PR #762 | Deleted 2026-10-14; restore source verified |
| `claude/pr700-field-season-delivery-20260920` | `fe13e961b` | PR #742 | Deleted 2026-10-14; restore source verified |
| `codex/pr624-acknowledgment-read-cleanup-20260913` | `b5357ce64` | PR #679 | Deleted 2026-10-14; restore source verified |
| `codex/pr624-acknowledgment-write-dedup-20260913` | `66a3907de` | PR #678 | Deleted 2026-10-14; restore source verified |
| `codex/pr624-batch-retry-integration-20260913` | `033921841` | PR #689 | Deleted 2026-10-14; restore source verified |
| `codex/pr624-confirmed-receiving-20260913` | `52556142d` | PR #674 | Deleted 2026-10-14; restore source verified |
| `codex/pr624-coverage-contracts-20260913` | `6e55c727b` | PR #675 | Deleted 2026-10-14; restore source verified |
| `codex/pr624-current-main-delivery-20260913` | `043413b2e` | PR #683 | Deleted 2026-10-14; restore source verified |
| `codex/pr624-final-candidate-20260913` | `0b87a742c` | PR #665 | Deleted 2026-10-14; restore source verified |
| `codex/pr624-final-review-corrections-20260913` | `0579a6881` | PR #680 | Deleted 2026-10-14; restore source verified |
| `codex/pr624-final-review-fixes-20260913` | `f7da37d57` | PR #676 | Deleted 2026-10-14; restore source verified |
| `codex/pr624-opus-reconciliation-20260913` | `e69874c46` | PR #673 | Deleted 2026-10-14; restore source verified |
| `codex/pr624-peer-acknowledgment-retention-20260913` | `2ce8c1217` | PR #685 | Deleted 2026-10-14; restore source verified |
| `codex/pr624-peer-claim-override-reconciliation-20260913` | `934615fce` | PR #681 | Deleted 2026-10-14; restore source verified |
| `codex/pr624-receipt-proof-fix-20260913` | `908940b51` | PR #671 | Deleted 2026-10-14; restore source verified |
| `codex/pr624-retry-preparation-warnings-20260913` | `f83acc19b` | PR #677 | Deleted 2026-10-14; restore source verified |
| `codex/pr624-staging-error-fix-20260913` | `dbd812a0f` | PR #667 | Deleted 2026-10-14; restore source verified |
| `claude/docs-cleanup-1-corrections` | `c86c7685f` | PR #809 | Deleted 2026-10-14; restore source verified |
| `claude/docs-cleanup-1-corrections-v10` | `ac3249ded` | PR #818 | Deleted 2026-10-14; restore source verified |
| `claude/docs-cleanup-1-corrections-v11` | `86db97600` | PR #819 | Deleted 2026-10-14; restore source verified |
| `claude/docs-cleanup-1-corrections-v12` | `697d73dd7` | PR #821 | Deleted 2026-10-14; restore source verified |
| `claude/docs-cleanup-1-corrections-v2` | `c86c7685f` | PR #810 | Deleted 2026-10-14; restore source verified |
| `claude/docs-cleanup-1-corrections-v3` | `cc763fb68` | PR #811 | Deleted 2026-10-14; restore source verified |
| `claude/docs-cleanup-1-corrections-v4` | `aeeb630c4` | PR #812 | Deleted 2026-10-14; restore source verified |
| `claude/docs-cleanup-1-corrections-v5` | `a1bc98818` | PR #813 | Deleted 2026-10-14; restore source verified |
| `claude/docs-cleanup-1-corrections-v6` | `24182a0c3` | PR #814 | Deleted 2026-10-14; restore source verified |
| `claude/docs-cleanup-1-corrections-v7` | `8123df326` | PR #815 | Deleted 2026-10-14; restore source verified |
| `claude/docs-cleanup-1-corrections-v8` | `47632834a` | PR #816 | Deleted 2026-10-14; restore source verified |
| `claude/docs-cleanup-1-corrections-v9` | `39c3bc6fb` | PR #817 | Deleted 2026-10-14; restore source verified |
| `chore/migration-ledger-reconcile-20260729` | `65716b1c2` | PR #275 | Deleted 2026-10-14; restore source verified |
| `claude/617-applied-live-docs` | `c787dca8c` | PR #729 | Deleted 2026-10-14; restore source verified |
| `claude/617-applied-live-docs-v2` | `4d7540684` | PR #733 | Deleted 2026-10-14; restore source verified |
| `claude/comment-fix-applied-closeout` | `01660702b` | PR #501 | Deleted 2026-10-14; restore source verified |
| `claude/refresh-schema-registry-after-restamp` | `3d199a5b6` | PR #710 | Deleted 2026-10-14; restore source verified |
| `claude/restamp-stranded-20260905-migrations` | `230f32baf` | PR #688 | Deleted 2026-10-14; restore source verified |
| `claude/restamp-stranded-20260905-migrations-delivery-2` | `5826926fc` | PR #695 | Deleted 2026-10-14; restore source verified |
| `claude/restamp-stranded-20260905-migrations-delivery-3` | `aa4c4abf1` | PR #701 | Deleted 2026-10-14; restore source verified |
| `claude/restamp-stranded-20260905-migrations-delivery-4` | `aa4c4abf1` | PR #702 | Deleted 2026-10-14; restore source verified |
| `claude/restamp-stranded-20260905-migrations-delivery-5` | `ec0af0d84` | PR #703 | Deleted 2026-10-14; restore source verified |
| `claude/schema-registry-refresh-20260905` | `dd2129072` | PR #602 | Deleted 2026-10-14; restore source verified |
| `claude/approval-head-binding-20260902` | `53e9c0714` | PR #556 | Deleted 2026-10-14; restore source verified |
| `claude/close-superseded-delivery-prs-20260914` | `133d10f25` | PR #705 | Deleted 2026-10-14; restore source verified |
| `claude/coderabbit-request-path-guard-text` | `834fdf976` | PR #634 | Deleted 2026-10-14; restore source verified |
| `claude/coderabbit-review-gate-b9f43a` | `a4483886f` | PR #569 | Deleted 2026-10-14; restore source verified |
| `claude/coderabbit-setup-optimize-0f308d` | `5b58e3524` | PR #441 | Deleted 2026-10-14; restore source verified |
| `claude/sol-skip-policy-proposal` | `c264695f0` | PR #870 | Deleted 2026-10-14; restore source verified |
| `codex/coderabbit-execution-context-20260913` | `feb925977` | PR #656 | Deleted 2026-10-14; restore source verified |
| `codex/coderabbit-native-landing-20260913` | `e85277969` | PR #654 | Deleted 2026-10-14; restore source verified |
| `codex/coderabbit-native-request-20260909` | `27531bf18` | PR #647 | Deleted 2026-10-14; restore source verified |
| `codex/coderabbit-snapshot-retry-20260913` | `e3f9d006f` | PR #655 | Deleted 2026-10-14; restore source verified |
| `claude/bind-adjust-inventory-receipt` | `76e2ae407` | PR #664 | Deleted 2026-10-14; restore source verified |
| `claude/bind-adjust-inventory-receipt-delivery-20260917-10` | `e7adccc8b` | PR #738 | Deleted 2026-10-14; restore source verified |
| `claude/bind-adjust-inventory-receipt-delivery-20260917-2` | `965089215` | PR #714 | Deleted 2026-10-14; restore source verified |
| `claude/bind-adjust-inventory-receipt-delivery-20260917-3` | `ed017afc7` | PR #716 | Deleted 2026-10-14; restore source verified |
| `claude/bind-adjust-inventory-receipt-delivery-20260917-4` | `5a837a1de` | PR #718 | Deleted 2026-10-14; restore source verified |
| `claude/bind-adjust-inventory-receipt-delivery-20260917-5` | `2939083b6` | tag archive/2026-10-13/claude/bind-adjust-inventory-receipt-delivery-20260917-5 (exists) | Deleted 2026-10-14; restore source verified |
| `claude/bind-adjust-inventory-receipt-delivery-20260917-6` | `b0d6236bb` | PR #727 | Deleted 2026-10-14; restore source verified |
| `claude/bind-adjust-inventory-receipt-delivery-20260917-7` | `6eca0d786` | PR #732 | Deleted 2026-10-14; restore source verified |
| `claude/bind-adjust-inventory-receipt-delivery-20260917-8` | `ca68bb3df` | PR #735 | Deleted 2026-10-14; restore source verified |
| `claude/bind-adjust-inventory-receipt-delivery-20260917-9` | `22ae064a1` | PR #737 | Deleted 2026-10-14; restore source verified |
| `claude/crx-soft-delete-download-revoke-50befc` | `66fec5a37` | PR #759 | Deleted 2026-10-14; restore source verified |
| `claude/crx-soft-delete-download-revoke-v2` | `ecb4055db` | PR #760 | Deleted 2026-10-14; restore source verified |
| `claude/crx-soft-delete-download-revoke-v3` | `d8c30f739` | PR #761 | Deleted 2026-10-14; restore source verified |
| `claude/crx-soft-delete-download-revoke-v4` | `470a3f375` | PR #763 | Deleted 2026-10-14; restore source verified |
| `claude/customer-document-rep-soft-delete` | `bb3432e08` | PR #769 | Deleted 2026-10-14; restore source verified |
| `codex/customer-document-soft-delete-20260908` | `a50130bfe` | PR #635 | Deleted 2026-10-14; restore source verified |
| `claude/field-season-install-20261001` | `14688aa8f` | PR #862 | Deleted 2026-10-14; restore source verified |
| `claude/field-season-install-20261001b` | `edcf6d6e6` | PR #865 | Deleted 2026-10-14; restore source verified |
| `claude/fix-field-app-invoice-test-date` | `ab6eede1d` | PR #860 | Deleted 2026-10-14; restore source verified |
| `claude/fix-invoice-date-test-rollover` | `870d79ee0` | PR #859 | Deleted 2026-10-14; restore source verified |
| `codex/field-app-current-main-20260914` | `dbd3fb333` | PR #700 | Deleted 2026-10-14; restore source verified |
| `codex/field-app-filed-season-guard-20260912` | `7a0ed406b` | PR #652 | Deleted 2026-10-14; restore source verified |
| `codex/field-app-season-final-20260913` | `e730b40b4` | PR #660 | Deleted 2026-10-14; restore source verified |
| `codex/field-app-season-review-fixes-20260913` | `dd3ce212c` | tag archive/2026-10-13/codex/field-app-season-review-fixes-20260913 (exists) | Deleted 2026-10-14; restore source verified |
| `codex/field-app-season-reviewed-20260913` | `5818d67ae` | PR #662 | Deleted 2026-10-14; restore source verified |
| `claude/actor-forgery-sweeps-20260902` | `c12c85ab8` | PR #551 | Deleted 2026-10-14; restore source verified |
| `claude/push-guard-git-resolution` | `62d22b6e9` | PR #445 | Deleted 2026-10-14; restore source verified |
| `claude/remove-guard-hooks-f23691` | `0ac235d0e` | PR #503 | Deleted 2026-10-14; restore source verified |
| `claude/session-orchestration-setup-d73e6c` | `238d242ea` | PR #364 | Deleted 2026-10-14; restore source verified |
| `codex/pr402-review-gaps-20260819` | `8811927ff` | PR #432 | Deleted 2026-10-14; restore source verified |
| `codex/proof-wrapper-trusted-git-bootstrap` | `a2e1d0a18` | PR #454 | Deleted 2026-10-14; restore source verified |
| `codex/sol-gate-recovery-exception` | `9817fb9e0` | PR #403 | Deleted 2026-10-14; restore source verified |
| `claude/codex-guard-single-ampersand` | `dddc6d748` | PR #464 | Deleted 2026-10-14; restore source verified |
| `claude/codex-recursion-hard-guard` | `47820dff7` | PR #452 | Deleted 2026-10-14; restore source verified |
| `claude/nested-guards-delivery-20260930` | `9704220f3` | PR #851 | Deleted 2026-10-14; restore source verified |
| `claude/peer-envelope-fence-504b` | `890b41dcb` | PR #768 | Deleted 2026-10-14; restore source verified |
| `claude/pr-630-adversarial-review-vrpl9r` | `e9e212fa3` | PR #795 | Deleted 2026-10-14; restore source verified |
| `fix/push-guard-binary-shape` | `81c70d7c8` | PR #626 | Deleted 2026-10-14; restore source verified |
| `claude/changelog-docs-honesty` | `cc8eed92c` | PR #505 | Deleted 2026-10-14; restore source verified |
| `claude/docs-cleanup-3-remove-finished` | `50f11d9ec` | PR #835 | Deleted 2026-10-14; restore source verified |
| `claude/docs-cleanup-3-remove-finished-v2` | `2f9bee7c1` | PR #854 | Deleted 2026-10-14; restore source verified |
| `claude/docs-cleanup-fix-stale-facts` | `98f60e6d0` | PR #807 | Deleted 2026-10-14; restore source verified |
| `claude/docs-review-best-practices-trv6qq` | `fbbe6fd31` | PR #836 | Deleted 2026-10-14; restore source verified |
| `claude/repo-docs-cleanup-101ef7` | `a3f58c581` | PR #803 | Deleted 2026-10-14; restore source verified |
| `codex/lean-agent-docs-20260904` | `f1d2037df` | tag archive/2026-10-13/codex/lean-agent-docs-20260904 (exists) | Deleted 2026-10-14; restore source verified |
| `claude/inventory-hold-retry-delivery` | `492331008` | PR #666 | Deleted 2026-10-14; restore source verified |
| `claude/inventory-hold-retry-delivery-2` | `80531fb64` | PR #670 | Deleted 2026-10-14; restore source verified |
| `claude/inventory-idempotency-key-reset-888161` | `b36de2ad8` | PR #624 | Deleted 2026-10-14; restore source verified |
| `codex/inventory-ack-reload-delivery-20260913` | `66afc1cb0` | PR #661 | Deleted 2026-10-14; restore source verified |
| `codex/inventory-peer-ack-delivery-20260913` | `86b9ecb3a` | PR #659 | Deleted 2026-10-14; restore source verified |
| `codex/inventory-retry-native-delivery-20260913` | `f7b7bfc6b` | PR #658 | Deleted 2026-10-14; restore source verified |
| `codex/harden-actor-binding-sql-reader` | `e652f7232` | PR #373 | Deleted 2026-10-14; restore source verified |
| `codex/section4-lifecycle-20260805` | `99cfcff58` | PR #321 | Deleted 2026-10-14; restore source verified |
| `codex/section9-ap-safety-remediation` | `0f8bf3aad` | PR #491 | Deleted 2026-10-14; restore source verified |
| `claude/pr611-land-20260905` | `231ad9cdd` | tag archive/2026-10-13/claude/pr611-land-20260905 (exists) | Deleted 2026-10-14; restore source verified |
| `fix/quote-fixture-stale-date` | `be5df11c5` | PR #468 | Deleted 2026-10-14; restore source verified |
| `ops/integrity-report-2026-09-01` | `a9dad49cb` | PR #539 | Deleted 2026-10-14; restore source verified |
| `ops/integrity-report-2026-10-01` | `fa748a0fd` | PR #861 | Deleted 2026-10-14; restore source verified |
| `preserve/crx-manager-uncommitted-archive-20260908` | `5dcdb853e` | tag archive/2026-10-13/preserve/crx-manager-uncommitted-archive-20260908 (exists) | Deleted 2026-10-14; restore source verified |
| `claude/codex-claude-cogs-handoff-7bde15` | `e3c4a3fc4` | tag archive/2026-10-13/claude/codex-claude-cogs-handoff-7bde15 (exists) | Deleted 2026-10-14; restore source verified |
| `claude/ordering-cycle-review-t41vat` | `992ee0888` | PR #363 | Deleted 2026-10-14; restore source verified |
| `claude/return-credit-cogs-reversal` | `c4e83dea6` | PR #361 | Deleted 2026-10-14; restore source verified |
| `claude/gallant-jackson-b07f96` | `d8a6fdbcd` | PR #822 | Deleted 2026-10-14; restore source verified |
| `claude/owner-approval-route-20260929` | `fd52fb461` | PR #845 | Deleted 2026-10-14; restore source verified |
| `claude/owner-approval-route-20260930` | `c9849dacc` | PR #853 | Deleted 2026-10-14; restore source verified |
| `codex/autonomy-with-hard-boundaries-20260827` | `3accebbef` | PR #513 | Deleted 2026-10-14; restore source verified |
| `claude/brace-expansion-audit-fix` | `8cbe2478b` | PR #848 | Deleted 2026-10-14; restore source verified |
| `claude/deps-audit-fix-20260930` | `1f7449f79` | PR #846 | Deleted 2026-10-14; restore source verified |
| `claude/deps-audit-fix-20260930-v2` | `1f7449f79` | PR #849 | Deleted 2026-10-14; restore source verified |
| `claude/js-yaml-high-advisory-20260908` | `cf28a8601` | PR #644 | Deleted 2026-10-14; restore source verified |

## Outcome of the 16 "after this PR" rows

| Branch | Commit | Restore from | Outcome |
|---|---|---|---|
| `claude/recover-applied-migrations-20260812` | `27817c2a5` | PR #395 | Deleted 2026-10-15 (02:51-02:55 UTC); restore source verified |
| `claude/bind-adjust-inventory-receipt-delivery-20260917` | `965089215` | PR #711 | Deleted 2026-10-15 (02:51-02:55 UTC); restore source verified |
| `claude/customer-document-rep-remove-page` | `fda25d4a6` | tag archive/2026-10-13/claude/customer-document-rep-remove-page (created 2026-10-15) | Deleted 2026-10-15 (02:51-02:55 UTC); restore source verified |
| `claude/customer-document-rep-remove-page-v2` | `aee5c0c1f` | tag archive/2026-10-13/claude/customer-document-rep-remove-page-v2 (created 2026-10-15) | Deleted 2026-10-15 (02:51-02:55 UTC); restore source verified |
| `claude/customer-document-rep-remove-page-v3` | `812174bc0` | tag archive/2026-10-13/claude/customer-document-rep-remove-page-v3 (created 2026-10-15) | Deleted 2026-10-15 (02:51-02:55 UTC); restore source verified |
| `claude/review-proof-guard-read-only-narrowing` | `e02709981` | PR #612 | Deleted 2026-10-15 (02:51-02:55 UTC); restore source verified |
| `claude/bash-safety-opacity-cleanup` | `bf54a52c9` | PR #527 | Deleted 2026-10-15 (02:51-02:55 UTC); restore source verified |
| `claude/live-data-guard-comment-aware` | `b326461e0` | PR #639 | Deleted 2026-10-15 (02:51-02:55 UTC); restore source verified |
| `claude/inventory-hold-retry-delivery-3` | `08cc28a41` | PR #672 | Deleted 2026-10-15 (02:51-02:55 UTC); restore source verified |
| `codex/idempotency-reset-order-hardening-20260802` | `9049efc80` | tag archive/2026-10-13/codex/idempotency-reset-order-hardening-20260802 (created 2026-10-15) | Deleted 2026-10-15 (02:51-02:55 UTC); restore source verified |
| `codex/pr-comment-remediation-20260903` | `5dbad8a3f` | PR #591 | Deleted 2026-10-15 (02:51-02:55 UTC); restore source verified |
| `codex/section1-security-hardening-20260725` | `53f6177eb` | tag preserve/2026-07-29/codex-section1-security-hardening-20260725 (exists) | Deleted 2026-10-15 (02:51-02:55 UTC); restore source verified |
| `claude/bulk-import-retry-scopes` | `ed62508e2` | tag archive/2026-10-13/claude/bulk-import-retry-scopes (created 2026-10-15) | Deleted 2026-10-15 (02:51-02:55 UTC); restore source verified |
| `claude/product-plan-rev12-followup` | `74ccba0f7` | PR #507 | Deleted 2026-10-15 (02:51-02:55 UTC); restore source verified |
| `codex/defer-return-credit-rollout-20260831` | `ac695f499` | PR #532 | Deleted 2026-10-15 (02:51-02:55 UTC); restore source verified |
| `claude/loosen-claude-permissions-20260905` | `d5cc21353` | PR #605 | Deleted 2026-10-15 (02:51-02:55 UTC); restore source verified |
