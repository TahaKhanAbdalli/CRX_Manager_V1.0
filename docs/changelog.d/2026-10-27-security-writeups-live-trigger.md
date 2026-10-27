## 2026-10-27 — Security write-up rule: one trigger and every public place (Luna round 1 on the rule)

- The `AGENTS.md` security write-up rule now uses a single trigger, "live in production (migration applied and code deployed)", instead of mixing "live" and "applied", so a merged but undeployed fix still keeps exploit detail out.
- It names every public place the rule covers: PR, issue, commit, review reply, changelog entry, release note and doc.
- The org-move checklist's after-move check now requires a new production error to show a Suspect Commit, not just the repo listed in Sentry.
