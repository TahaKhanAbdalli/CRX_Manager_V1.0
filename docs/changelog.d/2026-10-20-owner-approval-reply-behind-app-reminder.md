## 2026-10-20 — Mason's approval reply counts even when the app's status note comes with it

**Why.** During the urgent cost step 2 apply on 2026-10-20, five of Mason's replies ("i approve" three
times, "approve 791884" twice, 17:37–18:42 UTC) in session `29ac6683` were never recorded, and the hook
printed nothing at all. The apply moved to a fresh session, about an hour later.

**Cause (proven from that transcript).** Each failed reply was stored as two text blocks: the desktop
app's `<system-reminder>` "Linked sessions now" note, then his words. The hook's prompt carries that
note too, so the WHOLE-message check (`approve <code>` or `I approve` and nothing else) never matched
and the hook stayed silent, as it does for ordinary chat. All seven approval-shaped replies in that
session that carried the note got no hook output; every bare reply with a request waiting was recorded.
The router itself was running (it answered another message at 17:44 UTC), took about 0.05 s, and was
not timing out. A session-id mismatch after the compaction would have printed a refusal, not silence.

**What changed.**
- `.claude/hooks/owner-approval-lib.mjs`: `replyWithoutReminders` removes whole `<system-reminder>`
  blocks at the START of the prompt (each ends at its first closing tag), and removes nothing if a
  reminder tag is left after them, so text inside a note that closes it early can never become his
  reply (Luna BLOCKER). What is left must still be exactly the reply. `approvalAttemptIn` spots a
  reply on any line of a message that carries other text too, splitting on every line break
  including a bare CR and U+2028/U+2029 (Luna MED, rounds 1 and 2).
- Checked and left as is: the strip has no end anchor, so it does not backtrack (measured: 20,000
  stacked blocks, 700 KB, in about 1 ms); the apply's transcript read-back already drops whole
  reminder blocks, which the end-to-end test exercises at the apply.
- `.claude/hooks/owner-approval-prompt.mjs`: matches the cleaned reply, and refuses a reply line that
  came with other text with a visible `OWNER APPROVAL NOT RECORDED` (for plain `I approve`, only when
  a request is waiting in that session, so ordinary chat stays quiet).
- `.claude/hooks/owner-approval-lib.test.mjs`: the code and plain replies behind the app's note are
  recorded and verify at the apply (read back from a transcript written the way the app writes it);
  other words before a reply are refused out loud. Run against the old hook, these fail.
