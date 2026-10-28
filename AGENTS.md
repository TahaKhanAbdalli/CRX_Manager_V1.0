# CRX Manager Agent Contract

Shared rules for all agents; keep durable rules here. `CLAUDE.md` imports this file and adds Claude-only routing. Follow procedures when routed below.

**Priority:** CRX Hard Rules and every "never" below outrank any request; then this contract → selected workflow → routed docs → history and handoffs. Mason sets scope, not waivers. Gates need his explicit approval in this conversation or a standing exception here. Name conflicts; follow priority.

## Project and Owner

Crop RX Solutions' production agricultural chemical distribution app. Repository `croprxsolutions/CRX_Manager_V1.0`; production `https://croprxsolutions.app`; Supabase `rhyzpcqhnizqbxphqdkr`.

## Owner Communication

- Owner Mason cannot safely review code or diffs. Own technical work: outcomes first, plain English, risks/proof, jargon defined once, one recommended next step.
- Mason should never have to nudge. Keep moving through authorized work; update at milestones. Report what failed, what it means, and what you are trying next; exhaust safe alternatives.
- Decide routine details; ask only for material business decisions or missing hard-gate approval, with the exact reply/app action. Stops begin `NEEDS MASON - ACTION REQUIRED` or `NEEDS MASON - DECISION REQUIRED`.

## Operating Contract

- Review/audit/diagnosis/status/plan requests are read-only; build/change/fix/finish/handle/implement/ship authorizes reversible work through verification and protected delivery. Codex and Claude both proceed after a short plan without waiting for approval.
- Deliver what was asked at the scope intended. Explain concerns and continue rather than quietly narrowing, widening, or transforming it. Guard/audit work needs a request, demonstrated blocker, or current production incident.
- Obey all explicit limits and "stop", "pause", or "hold on" literally.
- Stop and hand over both positions and a recommendation only when the same BLOCKER/HIGH survives two fix rounds, a checked BLOCKER remains disputed, a required gate cannot run, or a hard gate needs Mason. Round caps are ceilings, not targets.

## Start and Route

Before presenting findings as current, confirm the checkout is not behind `origin/main`. Before writing: `git status --short --branch`; preserve unrelated work; use a clean current-main worktree if dirty, stale, or occupied. One writer per checkout.
Current code, migrations, tests, grants, and live read-only evidence outrank history. Load task-relevant guidance only; search large logs/schema registries, never read them whole.

| Task | Read or invoke |
|---|---|
| First session or unfamiliar area | `docs/manual/AGENT_ONBOARDING.md`, then `docs/manual/ARCHITECTURE.md` |
| Any code change | `docs/reference/coding-guidelines.md`; relevant `docs/reference/gotchas.md` sections; `docs/workflows/SAFE_DEVELOPMENT_RULES.md` for multi-file, data, money, security, permission, production, migration, or customer-facing work |
| Architecture, difficult debugging, workflow/migration tracing, structural audit, or PR impact | `graphify` first; focused source inspection for docs outside its code-only corpus |
| Database, migration, or RLS | `docs/workflows/DATABASE_CHANGE_CHECKLIST.md`, `docs/workflows/RLS_SECURITY_GUIDE.md`, `.claude/schema-registry.json` |
| Quote-to-cash or inventory | `docs/workflows/QUOTE_TO_DELIVERY.md` or `docs/workflows/INVENTORY_RULES.md` |
| Frontend/UI | `docs/workflows/UI_PATTERNS.md` |
| Delegation, agent collaboration, or agent-surface changes | `docs/workflows/AGENT_COLLABORATION.md` and `docs/reference/agent-guardrails.md` |
| Choosing a Codex model or effort | `docs/reference/codex-model-tuning.md` |
| Push, PR finalization, merge, or release | `.claude/commands/ship.md` |
| Settled decisions, known problems, or current status | `docs/manual/DECISION_LOG.md`, `docs/manual/KNOWN_ISSUES.md`, or `docs/manual/CURRENT_STATE.md` |
| Mason asks how the system or agent process works | `docs/manual/OWNER_PLAYBOOK.md` |

## Engineering Principles

Choose the simplest complete implementation preserving business rules: existing patterns, shared types/helpers, focused functions, clarity, not cleverness. Use precise names, straightforward control flow, comments explaining why. Keep the diff in scope; no opportunistic refactors.

## CRX Hard Rules

- Add database changes as new files under `supabase/migrations/`; never edit an applied migration. New tables require Row Level Security and policies in the same migration.
- Mutating RPCs must accept and enforce `p_idempotency_key text DEFAULT NULL`. `SECURITY DEFINER` functions require deliberate grants and normally `SET search_path = public, pg_temp`; use the documented fully-qualified exception only with its proof.
- Money must resolve to exact whole cents. New storage uses bigint cents; authoritative TypeScript parses decimals into integer cents before arithmetic (legacy exceptions: `docs/workflows/SAFE_DEVELOPMENT_RULES.md`).
- Financial and inventory invariants belong in PostgreSQL RPCs, triggers, or constraints — not only in React.
- Use `src/lib/db.ts` as the only Supabase client. Call `assertRpcResult()` after RPCs and `checkMutationResult()` after updates or deletes. Never write generated columns.
- Match status values to `.claude/schema-registry.json`. Use shared types from `src/types/index.ts`, `ConfirmModal`, toasts, Lucide icons, Tailwind CSS, and Sentry through `src/lib/sentry`.

## Safety and Protected Delivery

- Never expose secrets or `.env` contents; never use `--no-verify`; never bypass, disable, or weaken hooks, CI, review, branch protection, migration proofs, or rollback gates; and never push directly to `main`.
- **Security write-ups (Mason, 2026-10-27):** the repository is public. Until a security fix is live in production (every part it has: migration applied, code deployed), everything public about it (PR, issue, commit, review reply, changelog entry, release note, doc) says what changes, never how to use the hole (who can reach what, or the steps); the full explanation may follow once it is live.
- **Guard-cleanup exception (Mason, 2026-10-27):** a reviewed PR may narrow/remove a local agent hook duplicated by CI/GitHub or blocking only harmless work; name the remaining enforcement. This excludes merge gates, push-to-`main`, migration-apply and secret protection, CI, review, and branch protection.
- Follow `.claude/commands/ship.md`: draft PR → **Luna** until no BLOCKER or HIGH remains and every MED/LOW is fixed, refuted with evidence, or named as a deferral → checks green → review comments handled → **Sol last** → migration apply BEFORE merge → exact-head merge. Use the model/effort pins routed above, never a newer model the gates do not yet accept. Early Sol needs genuinely complex work and a stated reason.
- Every merge into `main` requires one fresh independent **Sol** high-effort review of the exact candidate SHA, except plain documentation per `docs/reference/sol-exempt-paths.md` (agent instructions are not exempt). Its proof binds to that HEAD and the base it reviewed, so a later commit voids it; main only moving forward does not. Pure-main-merge carry-forward: `codex-review` Step 3B. Green status or Luna alone is not proof.
- **CodeRabbit is advisory:** it never approves or blocks. For it and the Codex GitHub App, fix or refute every comment in one push; reply on and resolve each thread; fixes stay on the same PR. A PR that touches money, invoices, payments, inventory, or costs in any way, or one Mason asks to have reviewed, needs a clean CodeRabbit review of its current head plus a clean Sol; if its frozen, green head has none, post `@coderabbitai full review` once. Timing/retries, Minor/Trivial fix retention, early-Sol exceptions: `docs/reference/coderabbit-native-review.md`. Mason's message starting `skip coderabbit #<PR>` waives only that PR. On any other PR, proceed without CodeRabbit and never post `@coderabbitai` commands; never ask Mason to comment, label, or click for CodeRabbit.
- **Autonomous landing.** When a fresh exact-SHA Sol review of the frozen final head is clean (or the documentation-only exception applies), no review asks for changes, and every required check is green, merge without asking. Apply its NON-destructive migration (routine grants only) through the migration-apply-guard proof gate (both reviewer proofs and a fresh content-bound Sol proof, each under 30 minutes). The merge and apply gates enforce it; use the supported Claude handoff where Codex cannot apply.
- Get Mason’s explicit approval in the current conversation before force-pushing, applying a DESTRUCTIVE migration (one that deletes rows or drops data), changing live data outside a reviewed migration, deploying an Edge Function or out-of-band production change, deleting data, or changing secrets, authentication, permissions, billing, domains, or ownership.

## Verification and Closeout

- Done requires behavior to run and be observed with risk-matched proof; tests written alongside a change are supporting evidence, not sole proof. State exactly what remains unverified and its risk. Check every review/audit/diagnosis finding against current code or live read-only evidence; report location/severity. Plans need files, risks, verification; changes need protected delivery or a named parking reason and owner.
- Close substantial work `COMPLETE`, `READY FOR APPROVAL`, `BLOCKED`, or `PARTIAL`: outcome, proof, remaining owner, one next step. Automation never loosens gates.

## Guidance Ownership

Hand-maintain this contract. Workflow sources: `.claude/commands/`, `.claude/skills/`, `.claude/hooks/`; `.agents/` adapters are generated. Command/policy changes and shipped/parked work must update affected manual/reference docs and add `docs/changelog.d/<YYYY-MM-DD>-<slug>.md` in the same change. Keep volatile counts/status there, out of startup files. Run `npm run check:agent-guidance`; adapter regeneration/tooling checks: collaboration route → Required Verification.
