## 2026-10-19 — Goal 6: recovery runbook rewritten; backup-health alert designed

Rewrote `docs/operations/production-runbook.md` section 4 for the real state (Free plan, weekly
off-site database dump, no file backup) with clearly marked "AFTER PRO + PITR" parts: what is backed up,
who runs recovery (names still to be chosen by Mason), which recovery path to use, restore into a new
project against the backup-time baseline, a post-restore "nothing happens twice" checklist, the outage
paper fallback, and a drill log. Added `docs/plans/2026-10-19-goal6-backup-health-alert-design.md` (design only) and moved the unproven restore steps to `docs/plans/2026-10-19-goal6-restore-procedure-draft.md`, leaving runbook 4.6 as a short pointer with the safety rules.

Proof: documentation only; claims taken from `docs/plans/2026-10-18-goal-6-safety-net-findings.md`.
Not verified: no restore, decrypt or live check was run in this change; the `auth` schema being in the
dump is still unverified; the alert is not built. Needs Mason: Pro + PITR click, naming two recovery people,
and approval before any new secret is added to `CRX_Backups`.
