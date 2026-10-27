## 2026-10-27 — Security write-up rule fits fixes with no migration (Luna round 2 on the rule)

- The `AGENTS.md` security write-up trigger is now "every part it has: migration applied, code deployed", so a code-only fix can be written up once it is deployed.
- Org-move checklist: the GitHub click path to give Sentry access to the moved repo, and the Suspect Commit check may stay open until the first production error arrives (nothing waits on it).
