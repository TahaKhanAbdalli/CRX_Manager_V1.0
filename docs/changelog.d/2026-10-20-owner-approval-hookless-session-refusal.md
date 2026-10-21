## 2026-10-20 — The approval request refuses in a chat that cannot hear Mason's reply

**Why.** In desktop session `980692b3` Mason replied "i approve" twice (20:33 and 20:55 UTC) to an
approval self-test, and nothing recorded either reply or said anything. That session had no
UserPromptSubmit hook output at all. The repo cannot make Claude Code run its message hooks, but it
can notice beforehand that they are not running and refuse to ask him.

**What we checked first.** A transcript only records a message hook when the hook prints something,
so "no record" does not by itself prove a hook never ran. Across the last five days of desktop
transcripts, eight sessions whose very first message was not typed by Mason (a brief from another
session) produced message-hook output on it, so a session's first injected message does reach the hook in a working
session; a marker written on every message is a sound signal.

**What changed.**
- `.claude/hooks/owner-approval-lib.mjs`: `recordPromptHookSeen` writes
  `.claude/session-state/owner-approval-hook-seen-<session id>.json` (only in a folder that already
  has `.claude/`, never for a missing or path-like id, never throwing); `promptHookSeen` reads it for
  one session; `hooklessSessionRefusal` is the plain-English refusal.
- `.claude/hooks/owner-approval-prompt.mjs`: writes the marker on every message, before any approval
  matching, into the same folders it searches for requests.
- `scripts/owner-approve-migration.mjs`: both the migration request and `--selftest` refuse, exit 1,
  build no request, and print the fix (a fresh `claude` in a Terminal tab in the same folder) when
  this session has no marker.
- `.claude/hooks/owner-approval-lib.test.mjs`: the marker functions, and the script run as a real
  process before and after a message reaches the hook (alone and through `prompt-router.mjs`); a
  message in another session does not unlock it. Removing either the script's check or the hook's
  write makes these tests fail.

**Found while proving it.** The session that built this ran UserPromptSubmit hooks (they printed on an
app message) yet wrote no marker in its worktree: desktop worktree sessions here run the hooks from the
MAIN checkout `C:\CRX_Manager`, which still had the old hook. So session `980692b3` may have run the
pre-#979 hook from the main checkout (silent behind the app's note) rather than no hook at all; the marker
catches both. The refusal names this cause, and the main checkout must be fast-forwarded after this merges.

**Residual.** An agent could write the marker by hand; like faking the reply itself, that is the
deliberate forgery Mason accepted, not the silent loss this catches. A session already open before
this change has no marker until its next message. The marker proves the hook ran for some message in
the session, not that it will run for the next one (Luna MED, round 1, deferred): every silent session
seen so far ran no message hooks at all, and a time limit would refuse long sessions that work. If a
session ever drops hooks midway, add a freshness window then.
