## 2026-10-14 — docs cleanup, part 2: reference, workflow and root docs match the code

Second of two documentation-cleanup PRs. It touches only `.md` files, but some live in folders
that need the Sol review (`docs/reference/`, `docs/workflows/`, `docs/archive/`, `docs/operations/`,
`docs/loops/`, root docs and two never-eligible manual pages). Every factual change was checked against current code, migrations
or git history. No rule, gate or approval requirement was loosened; where a rule document and the
code disagree on a business rule, the document was left alone and the conflict went to Mason.

**Model names.** `docs/reference/claude-model-tuning.md` now lists Sonnet 5.5
(`claude-sonnet-5-5`) and Haiku 5.5 (`claude-haiku-5-5`), replacing Sonnet 5 and Haiku 4.5. The
advice to pin aliases stays.

**Agent-facing facts.**
- `AGENT_ONBOARDING.md`: a destructive migration is applied by the agent through
  `scripts/apply-migration-file.mjs` after Mason's recorded `I approve` for that file. The page
  said Mason applies it himself, which stopped being true with the chat-reply approval route.
- `OWNER_PLAYBOOK.md`: the Sol-exempt rule date (2026-10-07), the approval summary layout, the
  daily summary's winter time and record sources, the three kinds of parked change, the
  GitHub-versus-agent CodeRabbit requirement, and what the Personal DR backup covers.
- `agent-guardrails.md`: `isAckValvePath` (was `isAckValveWrite`); `regen-schema-registry` is a
  skill, not a workflow.
- `coderabbit-native-review.md`: the legacy fix loop is marked as legacy and names the
  once-per-head `@coderabbitai review` exception already stated in its banner and `AGENTS.md`.
- `production-migration-approval-gate.md`: notes the ledger-order migration was rejected and
  never applied.

**Code references.** `code-patterns.md` (metrics and `runCriticalAction` signatures, order
email origin, `db.ts` env behavior, tab counts), `pages-routes.md` (order email, reports
categories, the 11 office-cockpit tiles), `sql-canonical-patterns.md` (current idempotency helper
definitions), `UI_PATTERNS.md` (quote and order number formats, Compliance tabs, auth and
context folders) and `INVENTORY_RULES.md` (real `inventory_transactions` columns).

**Operations and root docs.** `production-runbook.md` now points at the protected landing,
migration and Edge Function procedures instead of a direct push to `main`, the MCP apply tool
and an unapproved deploy-all loop; it also fixes the no-PITR restore path, the month-end close
location, the pre-commit description and the `--no-verify` advice. `docs/CHANGELOG.md` says new
entries go in `docs/changelog.d/`. `ROADMAP.md` points to the 2026-10-13 direction doc.
`CONTRIBUTING.md` adds the changelog step. `SETUP-NEW-MACHINE.md` fixes the staleness-check
description and the Workflows table name.

**Archived** (moved to `docs/archive/2026-autumn-cleanup/`, with a README): the Phase 3C
review-packet loop and ledger, the Phase 3 goal contract, the cleanup-sprint progress table, and
one superseded PR #361 handoff. One audit reference was repointed. Three broken links in
`docs/archive/2026-spring/SESSION_FINAL_WAVE_3.md` were fixed.
