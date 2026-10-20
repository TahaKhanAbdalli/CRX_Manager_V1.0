## 2026-10-20 - Guard-file edit prompts removed (split out of PR #956)

**What.** `.claude/settings.json` no longer asks before an Edit or Write to guard files, settings,
workflows, Husky, `package.json` and the proof scripts: every `Edit(...)`/`Write(...)` entry is gone
from `permissions.ask`. The `.env` deny rules are unchanged. `scripts/check-agent-guidance.mjs` pins
the reversal again (restored from `824061121`): no Edit/Write ask entry may remain.

**Why.** Mason approved removing the prompts on 2026-10-18 ("Change permissions to not always prompt
me allow it"). Sol rated it HIGH during PR #956's review, so Mason split it out (2026-10-19, "Split
it") into this PR, which he merges himself.

**Risk Sol named.** Without the prompts a session could change a merge or push guard, merge, then
change the guard back before any PR diff shows it. What still stands: shell writes to guard files are
refused, Edit/Write calls stay in the transcript, and nothing reaches `main` without the PR path.

**Codex connector on `1a5abee75` (P1, fixed).** Three files that lost their prompt had no shell-write
deny either: the migration proof minter `scripts/write-apply-proofs.mjs`, its `-lib`, and
`scripts/supplier-pricing-phase3-private-artifacts.mjs`. A session could have rewritten the minter,
minted reviewer proofs, and restored it. All three now join `review-proof-guard.mjs`'s enforcement
surface (shell and path-field writes refused; running and reading allowed). A check of all 38
unprompted paths finds only `package.json` uncovered, by design.

**Takes effect** only after `C:/CRX_Manager` is fast-forwarded past the merge, because worktree
sessions load settings from the main checkout.
