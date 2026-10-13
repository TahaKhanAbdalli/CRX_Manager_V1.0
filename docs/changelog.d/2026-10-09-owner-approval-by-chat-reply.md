## 2026-10-09 — Mason approves parked migrations by chat reply instead of Windows Hello

**Why.** Mason works mostly from his phone, and the Windows Hello approval (2026-09-29) needed him at
the PC: "I want to remove the windows hello thing … I don't want more restrictions and hoops, I want
less." He was told the trade-off below and replied "go - i accept the trade off".

**What changed.**
- `scripts/owner-approve-migration.mjs` no longer opens Windows Hello. From the file itself it builds
  the same request as before (migration name and SQL sha256, PR number and exact head, the flagged
  categories, a nonce) plus a 6-digit code, a 24-hour reply deadline and the Claude Code session that
  built it (`CLAUDE_CODE_SESSION_ID`; it refuses to run without one). It saves the request in the
  checkout's `.claude/session-state/` and prints the plain-English summary, which ends with the exact
  reply. `--selftest` builds a request that approves nothing, to prove the reply path.
- `.claude/hooks/owner-approval-prompt.mjs` (new, wired in `prompt-router.mjs`): when Mason's WHOLE
  message is `approve <code>` (a trailing `.` or `!` is accepted, since phones add punctuation), the
  pending request with that code becomes an approval file stamped with the reply time. The code is
  retired exclusively BEFORE the approval is written, so if it cannot be retired nothing is approved,
  and a failed approval write leaves it retired (a fresh code is needed) (Luna LOW, CodeRabbit).
  Messages say an approval was recorded from the reply, not that Mason provably sent it. Requests are
  looked up ONLY in the folders of the session Mason replies in (Codex P1 on this PR), and the reply
  counts only when its `session_id` is the session that built the request, since two sessions can
  share one checkout (Luna HIGH, round 2). If the approval is saved
  but the used request cannot be removed (a Windows file lock), the hook still reports it recorded,
  because the approval file is what the gate accepts (Codex P2). A used code is retired in its
  folder, so no later request draws it and an old reply cannot approve a later request (Luna MED,
  round 3). The approval file is written to a temporary name and renamed into place, so the gate
  never reads a half-written one (CodeRabbit). The session's folders are reduced to their canonical
  path (case-insensitive on Windows) before lookup, so one checkout named with different casing is
  not mistaken for two and a valid reply is not refused as ambiguous (Codex P2). Any other message
  does nothing.
  A peer session's message (envelope or preamble), a subagent report, a quote, inline code, or a
  sentence around the reply never matches. A code pending in two checkouts approves neither.
- `owner-approval-lib.mjs`: the key, Windows Hello helper and signature checks are gone (purpose
  `…-v2`, so a v1 signed payload is refused). `verifyOwnerApproval` keeps every binding check (project,
  migration, sha256, PR, head, categories and reasons, summary, nonce, single use, live ledger). It
  adds: the reply came after the request and before its deadline, the apply is within 30 minutes of
  the reply, and the applying session is the one that built the request (fail closed when unknown).
  `OWNER_TRUST_FILES` now lists the reply hook instead of the key and helper.
- `migration-apply-lib.mjs` and `apply-migration-file.mjs`: no key reading; the apply script passes
  its `CLAUDE_CODE_SESSION_ID` as `ownerSessionId`; messages describe the reply. The 30-minute
  re-check before transmission counts from the reply.
- Removed: `scripts/owner-approval-setup.mjs`, `.claude/hooks/owner-approval-hello.ps1` and
  `.claude/hooks/owner-approval-key.json` (the review-proof guard blocks agent deletes under
  `.claude/hooks`, so Mason ran that `git rm` himself).
- Docs: OWNER_PLAYBOOK, DATABASE_CHANGE_CHECKLIST, DEPLOYMENT.md, agent-guardrails, ship.md, the
  create-migration, deploy-check and new-rpc skills, and a DECISION_LOG entry that supersedes rule 1
  of the 2026-09-29 entry.

**Residual risk (accepted by Mason).** The reply stops a parked migration being applied by mistake,
on a misread handoff, on a relayed "Mason said yes", or from a different conversation. It does not
stop an agent that deliberately fakes the approval: by writing the approval file itself, or by running
the reply hook by hand with a made-up message and session id (Luna round 2 made that second route
explicit; an earlier draft wrongly said no command could produce an approval). Agents run on his PC
with his permissions, and only Windows Hello could rule that out. The file sits in
`.claude/session-state`, which the review-proof guard protects like every other proof.

**Proof observed.**
- `owner-approval-lib.test.mjs`: 151 assertions. They include every verifier refusal, 21 messages
  that must not count as a reply (peer, quoted, code, longer sentences, wrong length), replies
  from another session or folder, a retired code, and the atomic write (replace, failure, no
  temporary file left). The reply hook also runs as a real process, alone and through
  `prompt-router.mjs`. In that run the recorded approval verifies at the apply, an unknown code is
  reported, a peer's relayed reply records nothing, and the exact reply from another session sharing
  the folder records nothing.
- `migration-apply-lib.test.mjs`: 297 assertions (291 before). For each of the three kinds a valid
  reply approval passes the apply script's door. The MCP door still refuses, and an approval never
  skips the reviewer proof or the landing gate. An approval more than 30 minutes after the reply is
  refused, as is one used in a session other than the one that built it.
- `npm run test:correction-guards`, `npm run test:agent-workflows` and `npm run agent-health` exit 0
  (agent-health first failed only on `core.hooksPath` pointing at the primary checkout's `.husky`;
  the repository's own `install-git-hooks.mjs`, run by `npm ci`, set it back to `.husky`).

**Not verified here.** Nothing was applied to the live database.
