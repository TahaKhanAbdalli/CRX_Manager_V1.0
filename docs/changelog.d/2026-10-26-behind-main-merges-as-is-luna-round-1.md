## 2026-10-26 — A pull request behind main merges as it is (Luna round 1)

- `.claude/commands/ship.md` and the codex-review skill no longer tell agents to merge main in and
  carry the Sol review forward every time main moves. Since the merge gates accept a behind head
  (same day), catching up is needed only when GitHub reports a conflict.
- `ship.md` Step 4 no longer says a review of a head behind main "can neither merge nor be carried
  forward"; it says the wrapper still reviews only a head that contains `origin/main`.
