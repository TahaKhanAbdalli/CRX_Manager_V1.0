#!/usr/bin/env node
// UserPromptSubmit half of Mason's owner approval (owner-approval-lib.mjs;
// Mason 2026-10-09: replaces Windows Hello so he can approve from his phone;
// 2026-10-13: a plain "I approve" is enough).
//   - His WHOLE message is `I approve` (or `approve`, `approved`, `yes I approve`)
//     right after the agent showed a pending request's reference number, or
//     `approve <6-digit code>`, in the session that built that request
//     (scripts/owner-approve-migration.mjs) → the request becomes an approval
//     good for 30 minutes, and the agent is told so.
//   - A plain `I approve` with no request waiting in this session is ordinary
//     chat: the hook says nothing.
//   - Any other message, or the reply in another session → nothing is approved.
//     A whole <system-reminder> block the app puts in front of his words is not
//     part of the message; a message with a reply on one of its lines but other
//     text as well is refused out loud, never silently (2026-10-20), except a
//     plain "I approve" line with no request waiting, which is ordinary chat.
//   - Every message leaves a marker that this session's messages reach this hook;
//     the request script refuses without it (some sessions never run it, 2026-10-20).
// Claude Code runs this on each message sent into a session. Nothing stops an
// agent running it by hand with a made-up message; that is the deliberate
// forgery Mason accepted as the residual (owner-approval-lib.mjs header).

import { readFileSync } from "node:fs";
import {
  approvalAttemptIn, approvalCodeFromReply, isPlainApprovalReply, lastAgentMessageText, ownerRequestDirs, recordPromptHookSeen, recordReplyApproval, replyMark,
  replyWithoutReminders, resolvePlainReply,
} from "./owner-approval-lib.mjs";

function emit(extra) {
  if (extra) {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: extra } }));
  }
  process.exit(0);
}

let payload;
try { payload = globalThis.__CRX_ROUTED_HOOK_PAYLOAD ?? JSON.parse(readFileSync(0, "utf8")); } catch { emit(); }
// Every message, approval or not: proof for the request script that messages in
// this session reach this hook (some sessions never run it, 2026-10-20).
try { recordPromptHookSeen({ dirs: ownerRequestDirs([payload?.cwd, process.env.CLAUDE_PROJECT_DIR, process.cwd()]), sessionId: payload?.session_id }); }
catch { /* a missing marker only makes the request script refuse */ }

// The app's reminder block in front of his words is not part of his reply (2026-10-20).
const reply = replyWithoutReminders(payload?.prompt);
let code = approvalCodeFromReply(reply);
const plain = !code && isPlainApprovalReply(reply);
// Not a whole reply, but one of its lines is: say it did not count rather than
// stay silent, so an approval is never lost without a word (2026-10-20). A plain
// "I approve" with nothing waiting in this session stays ordinary chat.
// The note's own lines are not his words, so they are never read as an attempt (CodeRabbit, PR #979).
const attempt = !code && !plain ? approvalAttemptIn(reply) : null;
if (!code && !plain && !attempt) emit();
const said = (attempt ? attempt.line : reply.trim()).slice(0, 40);

// Output happens only outside this try: under prompt-router.mjs process.exit
// throws, and a catch here would turn a clean exit into a failure.
let which = null;
let result;
let waiting = attempt?.kind === "code";
try {
  // Only THIS session's folders: a request another session built is never found here.
  const dirs = ownerRequestDirs([payload?.cwd, process.env.CLAUDE_PROJECT_DIR, process.cwd()]);
  if (attempt?.kind === "plain") waiting = !resolvePlainReply({ dirs, sessionId: payload?.session_id, readShown: () => "" }).silent;
  if (plain) {
    which = resolvePlainReply({
      dirs,
      sessionId: payload?.session_id,
      readShown: () => lastAgentMessageText(payload?.transcript_path, reply),
    });
    if (which.ok) code = which.code;
  }
  // readMark: where his reply lands in the transcript. The apply reads it back there
  // and refuses if a picture or file came with it (Codex P1, PR #900).
  if (code) {
    result = recordReplyApproval({
      code, dirs, reply, sessionId: payload?.session_id, readMark: () => replyMark(payload?.transcript_path, reply),
    });
  }
} catch (error) {
  result = { ok: false, reason: `the approval hook failed (${error?.message || error})` };
}

if (attempt && !result) {
  if (!waiting) emit();
  emit([
    `OWNER APPROVAL NOT RECORDED — Mason's message contained "${said}", but other text came with it, so it was not those words alone. Nothing was approved.`,
    "If he meant to approve the waiting database change, ask him to send the reply again as a message of its own: " +
      "only approve followed by the reference number (or I approve right after the request). Do not take this message as his approval.",
  ].join("\n"));
}

if (!result && which?.silent) emit();
if (!result) {
  emit([
    `OWNER APPROVAL NOT RECORDED — Mason replied "${said}", but ${which?.reason || "no request was found"}. Nothing was approved.`,
    "If he meant to approve the waiting database change, show him its request again: a reply containing ONLY its summary, exactly " +
      "as printed (no bold, code or quote marks). Anything you write in the same reply joins that message, so say it before a tool " +
      "call (for example, re-run the script) instead. Make it the last message of your turn and ask him to reply I approve. If it is refused again, ask him " +
      "to reply approve followed by the reference number instead, which names the request outright. Do not take this " +
      "message as his approval of anything else without checking what he meant.",
  ].join("\n"));
}

if (!result.ok) {
  emit([
    `OWNER APPROVAL NOT RECORDED — Mason replied "${said}", but ${result.reason}. Nothing was approved.`,
    "Tell him in one line. If he still wants the change, run node scripts/owner-approve-migration.mjs again for a fresh request, " +
      "from this session's own folder: a request is only found by the session it was built in.",
  ].join("\n"));
}

if (result.kind === "selftest") {
  emit(
    `OWNER APPROVAL TEST PASSED — the reply "${said}" in this session reached the approval hook and was recorded ` +
    `(${result.file}). Approving by chat reply works from where he sent it. Nothing was approved.`);
}

const p = result.payload;
emit([
  `OWNER APPROVAL RECORDED — the reply "${said}" in this session approved ${p.migration} (pull request ` +
    `#${p.pullRequest}, head ${String(p.prHead).slice(0, 12)}). It works once, for the next 30 minutes, for that exact file and head.`,
  `Apply it now: node scripts/apply-migration-file.mjs supabase/migrations/${p.migration}.sql (dry run), then again with --confirm.`,
  ...(result.requestLeft ? ["(The used request file could not be removed; it is harmless and needs no action.)"] : []),
].join("\n"));
