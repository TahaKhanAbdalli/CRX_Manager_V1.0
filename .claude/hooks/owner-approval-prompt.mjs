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
// Claude Code runs this on each message sent into a session. Nothing stops an
// agent running it by hand with a made-up message; that is the deliberate
// forgery Mason accepted as the residual (owner-approval-lib.mjs header).

import { readFileSync } from "node:fs";
import {
  approvalCodeFromReply, isPlainApprovalReply, lastAgentMessageText, ownerRequestDirs, recordReplyApproval, replyMark, resolvePlainReply,
} from "./owner-approval-lib.mjs";

function emit(extra) {
  if (extra) {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: extra } }));
  }
  process.exit(0);
}

let payload;
try { payload = globalThis.__CRX_ROUTED_HOOK_PAYLOAD ?? JSON.parse(readFileSync(0, "utf8")); } catch { emit(); }

const reply = String(payload?.prompt ?? "");
let code = approvalCodeFromReply(reply);
const plain = !code && isPlainApprovalReply(reply);
if (!code && !plain) emit();
const said = reply.trim().slice(0, 40);

// Output happens only outside this try: under prompt-router.mjs process.exit
// throws, and a catch here would turn a clean exit into a failure.
let which = null;
let result;
try {
  // Only THIS session's folders: a request another session built is never found here.
  const dirs = ownerRequestDirs([payload?.cwd, process.env.CLAUDE_PROJECT_DIR, process.cwd()]);
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
