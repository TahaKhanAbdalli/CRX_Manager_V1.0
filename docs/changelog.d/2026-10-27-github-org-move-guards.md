## 2026-10-27 — Guards accept the app repo's new organization address (GitHub org move, prep)

- New `.claude/hooks/app-repo-identity.mjs` lists both owners the app repo can live under: `masonwells1` (today) and the `croprxsolutions` organization it is moving to, so an outside developer can have read-only access.
- The Codex push gate, the CodeRabbit-skip waiver check and the memory-backup refusal now recognise `croprxsolutions/CRX_Manager_V1.0` as the app repo. Before this, a push straight to `main` at the new address was read as "some other repository" and allowed without a proof; it is now gated like the old address. Listing an owner only ever gates more.
- `docs/operations/github-org-move.md`: Mason's click-by-click steps for the move, the pre-move baseline, and the agent checks and follow-up PR that come after it. Nothing has moved yet.
