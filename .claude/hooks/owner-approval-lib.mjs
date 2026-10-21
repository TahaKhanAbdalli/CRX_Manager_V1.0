// OWNER APPROVAL (Mason, 2026-09-29: "approved all three"; by chat reply since
// 2026-10-09: "remove the windows hello thing ... I do a lot of work from phone",
// then "go - i accept the trade off" once the trade-off below was put to him).
//
// migration-apply-lib.mjs parks three kinds of migration for Mason: one that
// DELETES data, one that OVERWRITES existing rows, and one that CHANGES WHO CAN
// ACCESS WHAT. This module is how he approves one of them.
//
// Until 2026-10-09 he approved with a Windows Hello signature, which needed him
// at the PC. He works mostly from his phone, so the approval is now his reply in
// the chat:
//   1. scripts/owner-approve-migration.mjs builds a REQUEST from the file itself:
//      the exact migration (its name and the sha256 of its LF-normalized SQL), the
//      pull request and its exact head, what the safety check flagged, the Claude
//      Code session it was built in, and a 6-digit code. It is saved beside the
//      checkout's other proofs.
//   2. The agent shows Mason the plain-English summary, which ends with the code
//      as a reference number.
//   3. He replies `I approve` from anywhere, in THAT conversation, as his next
//      message (Mason, 2026-10-13: "I just want to say I approve and that's good
//      enough"). `approve <code>` still works and names the request outright.
//      owner-approval-prompt.mjs, which Claude Code runs as a UserPromptSubmit hook
//      on each message sent into a session, turns the request into an APPROVAL good
//      for 30 minutes only when the reply arrives in the session that built it. A
//      plain `I approve` counts only when the agent's message just before it showed
//      that request's reference number, so an "I approve" about something else
//      never approves a request still waiting from earlier.
//   4. scripts/apply-migration-file.mjs checks it LAST, after the reviewer proofs,
//      the Sol proof and the landing gate, refuses it in any other session, and
//      uses it up once.
//
// THE TRADE-OFF MASON ACCEPTED. The reply must be the WHOLE message, so a peer
// session's message (always wrapped in an envelope or preamble), a subagent's
// report or a quoted line never matches, and a reply in another conversation
// never counts. That stops a parked migration being applied by mistake, on a
// misread handoff, or on a relayed "Mason said yes". It does not stop an agent
// that deliberately fakes the approval — by writing the approval file, or by
// running the reply hook by hand with a made-up message and session id: agents
// run on Mason's PC with his permissions, and only Windows Hello could rule that
// out (Luna round 2, PR #894, made the second route explicit). The file lives in
// .claude/session-state, which the review proof guard protects like every other proof.
//
// It is NOT a general override. It only lets a parked migration continue to the
// SAME checks every other migration must pass; it only works through
// scripts/apply-migration-file.mjs; and it works once.

import { execFileSync } from "node:child_process";
import { createHash, randomInt } from "node:crypto";
import {
  closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { destructiveMigrationCheck } from "./live-testdata-lib.mjs";
import { accessChangeCheck, dataRewriteCheck } from "./migration-access-lib.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// v2 = approved by chat reply. A v1 (Windows Hello) payload is refused by purpose.
export const OWNER_APPROVAL_PURPOSE = "crx-owner-migration-approval-v2";
export const OWNER_SELFTEST_PURPOSE = "crx-owner-approval-selftest-v2";
export const OWNER_APPROVAL_VIA = "chat-reply";
// Once Mason replies, the agent has 30 minutes to apply.
export const OWNER_APPROVAL_MAX_AGE_MS = 30 * 60 * 1000;
// He may reply up to a day after the request. Anything that changed meanwhile
// (the file, the pull request head, what the safety check finds) still refuses it.
export const OWNER_REQUEST_MAX_AGE_MS = 24 * 60 * 60 * 1000;
// Mason works in Central time; the deadline he is shown uses it on every machine.
const OWNER_TIME_ZONE = "America/Chicago";

export const PARKED_LABELS = {
  "deletes-data": "Deletes data",
  "overwrites-data": "Overwrites existing data",
  "changes-access": "Changes who can access what",
};

const errText = (e) => (e && e.message ? e.message : e);

/**
 * What the safety check parks for Mason, in a fixed order. A classifier error
 * counts as a hit (fail closed), with the same reason text migration-apply-lib
 * has always used.
 */
export function parkedCategories(query, { history } = {}) {
  const out = [];
  let d;
  try { d = destructiveMigrationCheck(query); }
  catch (e) { d = { destructive: true, reason: `destructive-check error (${errText(e)}) — failing closed` }; }
  if (d.destructive) out.push({ category: "deletes-data", reason: String(d.reason) });
  let rewrite;
  try { rewrite = dataRewriteCheck(query, { history }); }
  catch (e) { rewrite = { rewrites: true, reason: `data-rewrite check error (${errText(e)}) — failing closed` }; }
  if (rewrite.rewrites) out.push({ category: "overwrites-data", reason: String(rewrite.reason) });
  let access;
  try { access = accessChangeCheck(query, { history }); }
  catch (e) { access = { changesAccess: true, reason: `access-check error (${errText(e)}) — failing closed` }; }
  if (access.changesAccess) out.push({ category: "changes-access", reason: String(access.reason) });
  return out;
}

/** The same file-safe form of a migration name migration-apply-lib uses. */
export const safeMigrationName = (migName) => String(migName).replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 80) || "unknown";
export const approvalFileName = (safeName) => `owner-approval-${safeName}.json`;
export const requestFileName = (code) => `owner-approval-request-${code}.json`;
export const selfTestResultName = (code) => `owner-approval-selftest-${code}.json`;
// A code is retired once a reply uses it, so an old `approve <code>` can never
// match a later request that drew the same 6 digits (Luna MED, round 3, PR #894).
export const usedCodeMarkerName = (code) => `owner-approval-code-used-${code}.json`;

/** A fresh 6-digit code: short enough to type on a phone. */
export const newApprovalCode = () => String(randomInt(0, 1_000_000)).padStart(6, "0");

function centralTime(iso) {
  return `${new Date(iso).toLocaleString("en-US", { timeZone: OWNER_TIME_ZONE, dateStyle: "medium", timeStyle: "short" })} Central`;
}

const clip = (s, n) => (String(s).length > n ? `${String(s).slice(0, n - 3)}...` : String(s));

/** The lines Mason sees before he replies. Derived only from payload fields. */
export function ownerApprovalSummary(p) {
  if (p.purpose === OWNER_SELFTEST_PURPOSE) {
    return [
      "This is a TEST of approving by chat reply.",
      "It approves nothing and changes nothing.",
      "",
      "To answer it, reply: I approve",
      `(Reference ${p.code}. You don't need to type it.)`,
    ];
  }
  return [
    "Approve this ONE change to the live CRX Manager database:",
    "",
    `Migration: ${p.migration}`,
    `Pull request: #${p.pullRequest} (version ${String(p.prHead).slice(0, 12)})`,
    `File fingerprint: ${String(p.queryHash).slice(0, 16)}`,
    "",
    "The safety check stopped it for you because it:",
    ...(p.categories || []).map((c) => `- ${PARKED_LABELS[c.category] || c.category}: ${c.reason}`),
    "",
    `To approve, reply: I approve (before ${centralTime(p.expiresAt)}).`,
    "It then works once, for 30 minutes, only for this exact file and version.",
    "Every other safety check still has to pass before it runs.",
    `(Reference ${p.code}. You don't need to type it.)`,
  ];
}

/** The request Mason approves. Field order is fixed; expiresAt is his reply deadline. */
export function buildApprovalPayload({ project, migration, queryHash, pullRequest, prHead, categories, issuedAt, expiresAt, nonce, code, sessionId }) {
  const p = {
    purpose: OWNER_APPROVAL_PURPOSE,
    project,
    migration,
    queryHash,
    pullRequest,
    prHead,
    categories: categories.map((c) => ({ category: c.category, reason: c.reason })),
    issuedAt,
    expiresAt,
    nonce,
    code,
    sessionId,
  };
  return JSON.stringify({ ...p, summary: ownerApprovalSummary(p) }, null, 2);
}

export function buildSelfTestPayload({ issuedAt, expiresAt, nonce, code, sessionId }) {
  const p = { purpose: OWNER_SELFTEST_PURPOSE, issuedAt, expiresAt, nonce, code, sessionId };
  return JSON.stringify({ ...p, summary: ownerApprovalSummary(p) }, null, 2);
}

// A Claude Code session id as the hook payload and CLAUDE_CODE_SESSION_ID carry it.
const usableSessionId = (s) => typeof s === "string" && /^[0-9A-Za-z_-]{8,128}$/.test(s);

/**
 * Save a request where the reply hook will look. A code already pending ("wx") or
 * already used in this checkout throws with code EEXIST, so the caller draws another.
 */
export function writeApprovalRequest(stateDir, payloadText) {
  const p = JSON.parse(payloadText);
  if (!/^\d{6}$/.test(String(p.code || ""))) throw new Error("the request has no usable code");
  if (existsSync(path.join(stateDir, usedCodeMarkerName(p.code)))) {
    throw Object.assign(new Error(`code ${p.code} was already used in this checkout`), { code: "EEXIST" });
  }
  mkdirSync(stateDir, { recursive: true });
  const file = path.join(stateDir, requestFileName(p.code));
  writeFileSync(file, `${JSON.stringify({ payload: payloadText }, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  return file;
}

// The WHOLE message must be the reply. A phone may capitalise the first letter
// and Mason may end with a period; anything more (other words, a quote, a peer's
// envelope or preamble) is not an approval.
const REPLY_RE = /^\s*approve\s+(\d{6})\s*[.!]?\s*$/i;

/** The code in Mason's reply, or null when the message is not exactly `approve <code>`. */
export function approvalCodeFromReply(prompt) {
  const m = REPLY_RE.exec(String(prompt ?? ""));
  return m ? m[1] : null;
}

// The plain reply (Mason, 2026-10-13): "I approve", "approve", "approved",
// "yes I approve", "I approve it", again only as the WHOLE message, and only those
// forms (CodeRabbit, PR #900). A bare "yes" or "go" is not one: he says those
// about everything.
const PLAIN_REPLY_RE = /^\s*(?:i\s+approve(?:\s+it)?|approve|approved|yes\s*[,.!]?\s+i\s+approve)\s*[.!]*\s*$/i;

/** True when the whole message is a plain approval with no code. */
export const isPlainApprovalReply = (prompt) => PLAIN_REPLY_RE.test(String(prompt ?? ""));

// The desktop app puts a whole <system-reminder> block (its "Linked sessions now"
// note) in front of Mason's words, and the hook's prompt carries it. On 2026-10-20
// five of his replies arrived that way and none matched the whole-message forms
// above, so the hook said nothing and an urgent apply stalled for an hour. Whole
// blocks at the START are not his words (the shape measured: the note first, his
// words last). Each block ends at its first closing tag, and if any reminder tag
// is left after them, nothing is removed: text inside a note (a session title)
// that closes it early and opens another must never become his reply (Luna
// BLOCKER, this PR).
const LEADING_REMINDERS_RE = /^(?:\s*<system-reminder>[\s\S]*?<\/system-reminder>)+\s*/;
const REMINDER_TAG_RE = /<\/?system-reminder\b/i;

/** Mason's reply without the whole reminder blocks the app put in front of it. */
export function replyWithoutReminders(prompt) {
  const text = String(prompt ?? "");
  const rest = text.replace(LEADING_REMINDERS_RE, "");
  return rest !== text && REMINDER_TAG_RE.test(rest) ? text : rest;
}

/**
 * When the message is not a whole reply but one of its lines is (other words or
 * an envelope came with it): which form ("code" or "plain") and that line; else
 * null. The hook then says it did not count instead of staying silent
 * (2026-10-20). Every line break counts, a bare CR and U+2028/9 too (Luna MED).
 */
export function approvalAttemptIn(prompt) {
  const lines = String(prompt ?? "").split(/\r\n|[\r\n\p{Zl}\p{Zp}]/u);
  const code = lines.find((l) => approvalCodeFromReply(l));
  if (code) return { kind: "code", line: code.trim() };
  const plain = lines.find((l) => isPlainApprovalReply(l));
  return plain ? { kind: "plain", line: plain.trim() } : null;
}

const textOf = (content) => (typeof content === "string" ? content
  : Array.isArray(content) ? content.filter((b) => b?.type === "text").map((b) => String(b.text ?? "")).join("\n") : "");
const isTextOnly = (content) => typeof content === "string" || (Array.isArray(content) && content.every((b) => b?.type === "text"));
// A whole <system-reminder> block that Claude Code puts in front of one of Mason's
// messages (a background task started, a worktree note) is not his words. Measured
// on every multi-block message on this machine (57, 2026-10-13): such a block came
// first and whole, and his own text was the last block.
const REMINDER_BLOCK_RE = /^\s*<system-reminder>[\s\S]*<\/system-reminder>\s*$/;
const masonText = (content) => (typeof content === "string" ? content
  : Array.isArray(content) ? content.filter((b) => b?.type === "text" && !REMINDER_BLOCK_RE.test(String(b.text ?? "")))
    .map((b) => String(b.text ?? "")).join("\n") : "");
// "I approve" sent with a picture or file could be about something else (Codex P1, PR #900).
const assertWordsAlone = (content) => {
  if (!isTextOnly(content)) throw new Error("his reply carried a picture or file as well as the words, so it was not those words alone");
};
// The bookkeeping records Claude Code writes after every turn and around each
// message (measured on a real session transcript, 2026-10-13). Nothing in them is
// shown to Mason as something to answer. Any OTHER entry between the agent's
// message and his reply (a message of his, image-only included; text Claude Code
// injects such as a Stop hook's feedback; a notification; a compaction; an error
// or synthetic message; a record type not listed here) ends the scan, so "I
// approve" is never carried past it (Luna rounds 1 and 3). A queue record that
// carries a message (one waiting to be delivered, or withdrawn) is not
// bookkeeping either, unless it is Mason's current message itself (Luna round 4).
const BOOKKEEPING_TYPES = new Set([
  "attachment", "last-prompt", "custom-title", "agent-name", "atis-latch", "pr-link",
  "bridge-session", "file-history-snapshot", "file-history-delta",
]);
const isBookkeeping = (e, currentPrompt) => BOOKKEEPING_TYPES.has(e?.type) ||
  (e?.type === "system" && e.subtype === "stop_hook_summary") ||
  (e?.type === "queue-operation" &&
    (e.content == null || String(e.content).trim() === String(currentPrompt ?? "").trim()));
const isToolResult = (e) => e?.type === "user" && Array.isArray(e.message?.content) && e.message.content.length > 0 &&
  e.message.content.every((b) => b?.type === "tool_result");
// A message the model wrote, not one Claude Code made up (an API error, an
// interruption notice) or marked as metadata (Luna HIGH, round 3).
const isAgentMessage = (e) => e?.type === "assistant" && !e.isMeta && !e.isApiErrorMessage && e.message?.model !== "<synthetic>";
// A message sent into the conversation: Mason's, or one Claude Code delivers like his (a notification).
const isMasonMessage = (e) => e?.type === "user" && !e.isMeta && !e.isSidechain && !isToolResult(e);
const DAMAGED = Symbol("damaged transcript line");

/** The transcript's size and the whole lines in its last `maxBytes` (a damaged line is DAMAGED). */
function readTranscriptTail(transcriptPath, maxBytes) {
  const fd = openSync(transcriptPath, "r");
  let raw;
  let size;
  try {
    size = fstatSync(fd).size;
    // Read from one byte before the window, so a window that starts exactly at a
    // line keeps that line: everything through the first newline is dropped, and
    // that newline is the byte before the line (Luna LOW, round 4).
    const start = size > maxBytes ? size - maxBytes - 1 : 0;
    const buf = Buffer.alloc(size - start);
    let got = 0;
    while (got < buf.length) {
      const n = readSync(fd, buf, got, buf.length - got, start + got);
      if (n <= 0) break;
      got += n;
    }
    raw = buf.subarray(0, got).toString("utf8");
    if (start > 0) raw = raw.slice(raw.indexOf("\n") + 1); // drop the partial first line
  } finally {
    closeSync(fd);
  }
  // Every line is either a whole entry or damage: a half-written line could be
  // one of Mason's messages, so it is never skipped (Luna HIGH, round 2).
  const entries = raw.split("\n").filter((l) => l.trim()).map((line) => {
    try { return JSON.parse(line); } catch { return DAMAGED; }
  });
  return { size, entries };
}

/**
 * What the agent said to Mason last: the text of the final main-thread assistant
 * message before his reply (Claude Code stores one message as several entries
 * sharing its message id), read from the session transcript Claude Code hands the
 * hook. Only that message counts, so a request shown earlier in the same turn,
 * before a later question, is not what "I approve" answers (Luna HIGH, round 2).
 * If any message reached the session after the agent's last message (another of
 * Mason's, or a notification), the result is empty. His current message may or
 * may not be written yet; when it is, it is skipped.
 *
 * Throws, so a plain reply then approves nothing, when the transcript cannot be
 * read, when a damaged line lies in what is scanned, or when the start of that
 * message cannot be found in the part read (Luna rounds 1-2).
 */
export function lastAgentMessageText(transcriptPath, currentPrompt, { maxBytes = 32 * 1024 * 1024 } = {}) {
  if (typeof transcriptPath !== "string" || !transcriptPath) throw new Error("the message carried no transcript");
  const { entries } = readTranscriptTail(transcriptPath, maxBytes);
  const said = [];
  let messageId;
  let sawAgent = false;
  let skippedCurrent = false;
  let found = false; // the scan stopped on a real boundary, not the edge of what was read
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e === DAMAGED) throw new Error("a damaged transcript line lies in what had to be read");
    if (isBookkeeping(e, currentPrompt) || e?.isSidechain) continue; // a subagent's entries are not the conversation with Mason
    // A tool call or its result after the agent's last words means it went on
    // working, or asked him something through a tool, after them: "I approve" may
    // answer that instead, so nothing it said counts (Sol HIGH, PR #900). Before
    // its last words, it is where that message begins.
    if (isToolResult(e)) { found = true; break; }
    if (isAgentMessage(e)) {
      sawAgent = true;
      const t = textOf(e.message?.content);
      if (!said.length) {
        if (Array.isArray(e.message?.content) && e.message.content.some((b) => b?.type === "tool_use")) { found = true; break; }
        if (!t) continue;
        said.unshift(t);
        messageId = e.message?.id;
        // Claude Code gives every assistant message an id; without one, where the
        // message starts cannot be told, so nothing is concluded.
        if (!messageId) throw new Error("the agent's last message carries no message id");
        continue;
      }
      if (e.message?.id !== messageId) { found = true; break; }
      if (t) said.unshift(t);
      continue;
    }
    // Mason's current message, when it is already written, is the one entry skipped,
    // and only when it is those words alone (Codex P1, PR #900).
    if (!sawAgent && !skippedCurrent && e?.type === "user" && !e.isMeta &&
      masonText(e.message?.content).trim() === String(currentPrompt ?? "").trim()) {
      assertWordsAlone(e.message?.content);
      skippedCurrent = true;
      continue;
    }
    // Anything else ends the scan: after the agent's message it means nothing it
    // said counts; before it, it is where that message begins.
    found = true;
    break;
  }
  // Running off the start of what was read proves nothing: the message, or a
  // message of Mason's after it, could lie before it (Luna HIGH, rounds 1-2).
  if (!found) throw new Error("the start of the agent's last message is not in the part of the transcript read");
  return said.join("\n");
}

/**
 * Where Mason's reply is in the session transcript, kept with his approval so the
 * apply can read that message back (assertReplyAlone). The hook's input holds only
 * his words, and Claude Code normally writes his message just AFTER the hook runs
 * (measured on a real transcript, 2026-10-13), so whether he sent a picture or file
 * with it can only be seen once it is written (Codex P1 twice, PR #900).
 *   from     the transcript's size now: a message not yet written lands after it.
 *   written  his message is already the last one written; it is checked here.
 *   words    his reply, trimmed.
 * Throws when there is no readable transcript, so nothing is approved.
 */
export function replyMark(transcriptPath, reply, { maxBytes = 1024 * 1024 } = {}) {
  if (typeof transcriptPath !== "string" || !transcriptPath) throw new Error("the message carried no transcript");
  const words = String(reply ?? "").trim();
  const { size, entries } = readTranscriptTail(transcriptPath, maxBytes);
  let written = false;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e === DAMAGED) throw new Error("a damaged transcript line lies at its end");
    if (isBookkeeping(e, words) || e?.isSidechain) continue;
    if (isMasonMessage(e) && masonText(e.message?.content).trim() === words) {
      assertWordsAlone(e.message?.content);
      written = true;
    }
    break;
  }
  return { transcript: path.resolve(transcriptPath), from: size, written, words };
}

/**
 * At the apply: Mason's reply, read back from the transcript now that Claude Code
 * has written it, must be his words alone, with no picture or file (Codex P1, PR
 * #900). The first message after `from` is his reply; if the agent's answer comes
 * first, his reply was already written, and checked, when he sent it. Throws
 * otherwise, so the approval is refused.
 */
export function assertReplyAlone(mark, { maxBytes = 8 * 1024 * 1024 } = {}) {
  if (!mark || typeof mark.transcript !== "string" || !mark.transcript || !Number.isSafeInteger(mark.from) || mark.from < 0 ||
    typeof mark.written !== "boolean" || typeof mark.words !== "string" || !mark.words) {
    throw new Error("the approval does not say where his reply is in the conversation");
  }
  const fd = openSync(mark.transcript, "r");
  let raw;
  try {
    const size = fstatSync(fd).size;
    if (size < mark.from) throw new Error("the conversation's transcript is shorter than when he replied");
    const buf = Buffer.alloc(Math.min(size - mark.from, maxBytes));
    let got = 0;
    while (got < buf.length) {
      const n = readSync(fd, buf, got, buf.length - got, mark.from + got);
      if (n <= 0) break;
      got += n;
    }
    raw = buf.subarray(0, got).toString("utf8");
  } finally {
    closeSync(fd);
  }
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let e;
    // A damaged line, or the last one cut by the read or still being written.
    try { e = JSON.parse(line); } catch { throw new Error("a damaged or unfinished transcript line lies where his reply should be"); }
    if (isMasonMessage(e)) {
      if (masonText(e.message?.content).trim() !== mark.words) throw new Error("the message written where his reply should be is not his reply");
      assertWordsAlone(e.message?.content);
      return;
    }
    if (isAgentMessage(e) && !e.isSidechain) {
      if (mark.written) return;
      throw new Error("his reply is not where the approval says it is");
    }
  }
  throw new Error("his reply is not in the transcript");
}

/**
 * True when the text IS this request's summary (ownerApprovalSummary), word for
 * word, and nothing else. So he is always shown what it is, the pull request and
 * version, the fingerprint, every reason the safety check stopped it, the reply
 * it asks for and its Reference line, and "I approve" can only answer that: a
 * question, a note or anything else in the same message means it does not count
 * (CodeRabbit, PR #900); the agent explains the change in an earlier message.
 * Nor does a message that only cites an old reference, says "Do not reply: I
 * approve", or puts the summary's words inside other prose (Luna BLOCKER round 4;
 * Codex P1 and CodeRabbit, PR #900).
 * The words are compared exactly as the script printed them: only spacing,
 * blank lines, where lines wrap, and a code fence around the whole summary may
 * differ. No markdown is interpreted, so no character in a name, fingerprint or
 * reason can be dropped or reinterpreted (drop_a_b is never drop_ab or
 * drop_a__b__; Codex P1 and CodeRabbit, PR #900). The agent copies the summary
 * as printed; anything else (bold, code marks, quote marks, an HTML comment)
 * means it does not count, and he is asked again.
 */
export function requestShownIn(text, p) {
  if (!/^\d{6}$/.test(String(p?.code ?? ""))) return false;
  const words = (lines) => lines.filter((l) => !/^\s*```[\w-]*\s*$/.test(l)).join(" ").replace(/\s+/g, " ").trim();
  const summary = words(ownerApprovalSummary(p));
  return summary !== "" && words(String(text ?? "").split(/\r?\n/)) === summary;
}

/**
 * Which request a plain `I approve` is for. The live requests this session built
 * (pending, unexpired, code not retired) are matched against the agent's last message:
 * exactly one of them must be shown there (requestShownIn).
 *
 * @param {object} args
 * @param {string[]} args.dirs  this session's session-state folders (ownerRequestDirs)
 * @param {string} args.sessionId
 * @param {() => string} args.readShown  the agent's last message (lastAgentMessageText); may throw
 * @returns {{silent: true}|{ok: false, reason: string}|{ok: true, code: string}}
 *   silent: nothing is waiting in this conversation, so the message is ordinary chat.
 */
export function resolvePlainReply({ dirs, sessionId, readShown, now = Date.now() }) {
  if (!usableSessionId(sessionId)) return { silent: true };
  const live = new Map();
  // Silence must mean "nothing is waiting", never "could not tell" (Luna LOW, round 2).
  for (const dir of new Set(dirs || [])) {
    let names;
    try { names = readdirSync(dir); }
    catch (e) {
      if (e?.code === "ENOENT") continue;
      return { ok: false, reason: `the approval folder ${dir} could not be read (${errText(e)})` };
    }
    for (const name of names) {
      const m = /^owner-approval-request-(\d{6})\.json$/.exec(name);
      if (!m || existsSync(path.join(dir, usedCodeMarkerName(m[1])))) continue;
      let p;
      try { p = JSON.parse(JSON.parse(readFileSync(path.join(dir, name), "utf8")).payload); }
      catch (e) { return { ok: false, reason: `the request file ${name} could not be read (${errText(e)})` }; }
      const deadline = Date.parse(p?.expiresAt);
      if (p?.sessionId === sessionId && String(p?.code) === m[1] && Number.isFinite(deadline) && now <= deadline) live.set(m[1], p);
    }
  }
  if (!live.size) return { silent: true };
  let shownText;
  try { shownText = String(readShown() ?? ""); }
  catch (e) { return { ok: false, reason: `what the agent last showed him could not be read (${errText(e)})` }; }
  const shown = [...live].filter(([, p]) => requestShownIn(shownText, p)).map(([c]) => c);
  if (!shown.length) {
    return { ok: false, reason: "the agent's message just before it did not show the approval request's summary alone (word for word, nothing else), so it may have been about something else" };
  }
  if (shown.length > 1) return { ok: false, reason: `the agent's last message showed ${shown.length} requests (${shown.join(", ")}), so it is ambiguous` };
  return { ok: true, code: shown[0] };
}

/**
 * The session-state directories a request may be in: ONLY the folders of the
 * session Mason is replying in. A request another session built in another
 * worktree is never found, so his reply in one conversation cannot approve an
 * apply that a different conversation runs (Codex P1, PR #894: AGENTS.md wants
 * his approval in the applying conversation).
 */
export function ownerRequestDirs(sessionFolders) {
  // The payload cwd, CLAUDE_PROJECT_DIR and the hook's cwd may name one checkout
  // with different drive-letter or folder casing on Windows. Without a canonical
  // key the same request is found twice and a valid reply is refused as
  // ambiguous (Codex P2, PR #894).
  const canonical = (s) => {
    const r = path.resolve(s);
    try { return realpathSync.native(r); } catch { return r; }
  };
  const key = (p) => (process.platform === "win32" ? p.toLowerCase() : p);
  const roots = new Map();
  for (const s of (sessionFolders || []).filter(Boolean)) {
    const c = canonical(s);
    if (!roots.has(key(c))) roots.set(key(c), c);
  }
  return [...roots.values()].map((r) => path.join(r, ".claude", "session-state"));
}

// HOOKLESS SESSIONS (2026-10-20). In some desktop sessions Claude Code never runs
// UserPromptSubmit hooks (session 980692b3: Mason replied "i approve" twice and
// nothing heard it). The repo cannot make the hook run, so the reply hook leaves
// this marker on every message it sees, and the request script refuses to ask
// Mason for a reply in a session with no marker. An agent could write the file by
// hand; like the reply itself (header above), that is deliberate forgery, not the
// silent loss this catches.
const SESSION_ID_RE = /^[0-9A-Za-z_-]{8,128}$/;
export const promptHookSeenName = (sessionId) => `owner-approval-hook-seen-${sessionId}.json`;

/**
 * Called by the reply hook on every message: note that a message in this session
 * reached it. Only in a folder that already has .claude/ (never creates project
 * folders), and never throws: a missing marker only makes the script refuse.
 */
export function recordPromptHookSeen({ dirs, sessionId, now = Date.now() }) {
  if (!SESSION_ID_RE.test(String(sessionId || ""))) return 0;
  let wrote = 0;
  for (const dir of dirs || []) {
    try {
      if (!existsSync(path.dirname(dir))) continue;
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, promptHookSeenName(sessionId)), `${JSON.stringify({ sessionId, seenAt: new Date(now).toISOString() })}\n`, "utf8");
      wrote++;
    } catch { /* best effort */ }
  }
  return wrote;
}

/** Whether a message in this session has reached the reply hook (its marker is in one of `dirs`). */
export function promptHookSeen({ dirs, sessionId }) {
  if (!SESSION_ID_RE.test(String(sessionId || ""))) return false;
  return (dirs || []).some((dir) => {
    try { return JSON.parse(readFileSync(path.join(dir, promptHookSeenName(sessionId)), "utf8"))?.sessionId === sessionId; }
    catch { return false; }
  });
}

/** What the request script prints instead of a request when the marker is missing. */
export function hooklessSessionRefusal({ checkout, sessionId }) {
  return [
    "owner-approve-migration: REFUSED — do NOT ask Mason to reply \"I approve\" in this conversation.",
    `No message in this session (${sessionId}) has reached the approval hook: there is no ${promptHookSeenName(sessionId)}`,
    `in ${path.join(checkout, ".claude", "session-state")}. Usually Claude Code is not running message hooks here (or the hook could not save`,
    "its marker in that folder); either way his reply could be lost without a word.",
    "Tell Mason in plain English, then the fix: open a Terminal tab in this same folder,",
    `  ${checkout}`,
    "start a fresh `claude` there, and run this script from that session; he replies in that terminal conversation.",
    "(If this conversation started before this check existed, any new message into it records the marker; then run this again.",
    "A desktop session in a worktree may run the hooks from the repository's MAIN checkout: if that checkout is behind main,",
    "its older hook writes no marker, so fast-forward it to main, then any new message records the marker.)",
  ].join("\n");
}

/**
 * Turn Mason's reply into an approval: the pending request with this code becomes
 * an approval file beside it, stamped with when he replied. Only the reply hook
 * calls this.
 *
 * @returns {{ok: true, kind: "migration"|"selftest", payload: object, file: string, requestLeft: boolean}|{ok: false, reason: string}}
 */
export function recordReplyApproval({ code, dirs, reply, sessionId, readMark, now = Date.now(), removeRequest = (f) => rmSync(f, { force: true }) }) {
  const no = (reason) => ({ ok: false, reason });
  if (!usableSessionId(sessionId)) return no("the message carried no usable session id");
  const hits = [];
  for (const dir of new Set(dirs || [])) {
    const file = path.join(dir, requestFileName(code));
    if (existsSync(file)) hits.push({ dir, file });
  }
  if (!hits.length) return no(`no pending approval request has the code ${code}`);
  if (hits.length > 1) return no(`${hits.length} pending requests share the code ${code}, so it is ambiguous`);
  const { dir, file } = hits[0];
  if (existsSync(path.join(dir, usedCodeMarkerName(code)))) return no(`the code ${code} was already used; ask for a fresh one`);
  let payloadText;
  let p;
  try {
    payloadText = JSON.parse(readFileSync(file, "utf8")).payload;
    p = JSON.parse(payloadText);
  } catch {
    return no(`the request for code ${code} is unreadable`);
  }
  if (String(p?.code) !== code) return no(`the request file does not carry the code ${code}`);
  const selftest = p.purpose === OWNER_SELFTEST_PURPOSE;
  if (!selftest && p.purpose !== OWNER_APPROVAL_PURPOSE) return no(`the request for code ${code} is not a migration approval request`);
  // Sessions that share a checkout share its session-state: the request names the
  // session that built it, and only a reply in that session counts (Luna HIGH,
  // round 2, PR #894).
  if (p.sessionId !== sessionId) return no(`the request for code ${code} was built in a different conversation; Mason must reply in the one that asked him`);
  const deadline = Date.parse(p.expiresAt);
  if (!Number.isFinite(deadline) || now > deadline) return no(`the request for code ${code} expired at ${p.expiresAt}`);
  // Where his reply is (replyMark), so the apply can check it was his words alone.
  let mark;
  try { mark = readMark?.(); }
  catch (e) { return no(`where his reply is in the conversation could not be read (${errText(e)})`); }
  if (!mark || typeof mark !== "object") return no("where his reply is in the conversation is unknown");
  const approval = {
    payload: payloadText, approvedAt: new Date(now).toISOString(), via: OWNER_APPROVAL_VIA, reply: clip(String(reply ?? "").trim(), 40), replyMark: mark,
  };
  const out = path.join(dir, selftest ? selfTestResultName(code) : approvalFileName(safeMigrationName(p.migration)));
  // Retire the code FIRST, exclusively: if it cannot be retired, nothing is
  // approved, so a code is never live without its retirement on disk. If the
  // approval write below then fails, the code stays retired and Mason is asked
  // for a fresh one — the safe direction (Luna LOW round 4, CodeRabbit, PR #894).
  try {
    writeFileSync(path.join(dir, usedCodeMarkerName(code)),
      `${JSON.stringify({ code, usedAt: approval.approvedAt }, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  } catch (e) {
    return no(e?.code === "EEXIST"
      ? `the code ${code} was already used; ask for a fresh one`
      : `the code ${code} could not be retired (${errText(e)}), so nothing was approved`);
  }
  // Write beside the target, then rename into place: the apply gate never reads a
  // half-written approval, and replacing an earlier one is atomic (CodeRabbit, PR #894).
  const tmp = `${out}.tmp-${process.pid}-${now}`;
  try {
    writeFileSync(tmp, `${JSON.stringify(approval, null, 2)}\n`, "utf8");
    renameSync(tmp, out);
  } catch (e) {
    try { rmSync(tmp, { force: true }); } catch { /* best effort */ }
    return no(`the approval could not be saved (${errText(e)})`);
  }
  // Once the approval file exists it IS the authorization, so a failure to remove
  // the request afterwards (a Windows file lock) still reports success; saying
  // "nothing was approved" would misstate what the apply gate will accept (Codex
  // P2, PR #894). A leftover request can only be re-approved by another reply.
  let requestLeft = false;
  try { removeRequest(file); } catch { requestLeft = true; }
  return { ok: true, kind: selftest ? "selftest" : "migration", payload: p, file: out, requestLeft };
}

// One marker FILE per used approval, created exclusively ("wx"): two applies
// racing on the same approval cannot both create it, so only one transmits
// (Luna HIGH, 2026-09-29). Its existence is what counts, so a damaged marker still
// reads as used; an unreadable directory refuses (Luna MED: fail closed).
const USED_MARKER_RE = /^owner-approval-used-([0-9A-Za-z_-]{1,128})\.json$/;
export const usedMarkerName = (nonce) => `owner-approval-used-${nonce}.json`;

/** Nonces already used, from every directory approvals may come from. Throws if one cannot be read. */
export function readUsedNonces(dirs) {
  const used = new Set();
  for (const dir of dirs || []) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      const m = name.match(USED_MARKER_RE);
      if (m) used.add(m[1]);
    }
  }
  return used;
}

/**
 * Claim an approval BEFORE the apply transmits. Throws if it was already claimed
 * (by this or a concurrent run) or cannot be recorded.
 */
export function recordUsedApproval(dir, payloadText, now = Date.now()) {
  const p = JSON.parse(payloadText);
  if (!/^[0-9A-Za-z_-]{1,128}$/.test(String(p.nonce || ""))) throw new Error("the approval's nonce is malformed");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, usedMarkerName(p.nonce)),
    `${JSON.stringify({ nonce: p.nonce, migration: p.migration, prHead: p.prHead, usedAt: new Date(now).toISOString() }, null, 2)}\n`,
    { encoding: "utf8", flag: "wx" });
}

/**
 * SQL placed at the start of an owner-approved apply's transaction (Luna HIGH,
 * round 2): lock on the migration's name, then refuse if the ledger already holds
 * it. Local "used" markers are files an agent could delete; this is enforced by the
 * database, and two racing applies serialize on the lock so the second rolls back.
 * `tag` is the apply script's dollar-quote tag; both tags are checked absent.
 */
export function ownerOnceGuardSql({ tag, migName, sql }) {
  const dq = `$${tag}$`;
  const guardTag = `$${tag}_guard$`;
  for (const t of [dq, guardTag]) {
    if (String(sql).includes(t) || String(migName).includes(t)) throw new Error(`dollar-quote tag ${t} collides with the payload`);
  }
  return `SELECT pg_advisory_xact_lock(hashtext(${dq}crx-owner-approved:${migName}${dq}));\n` +
    `DO ${guardTag} BEGIN\n` +
    `  IF EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE name = ${dq}${migName}${dq}) THEN\n` +
    `    RAISE EXCEPTION 'OWNER_APPROVAL_ALREADY_APPLIED: % is already in the ledger; one approval covers one install', ${dq}${migName}${dq};\n` +
    `  END IF;\n` +
    `END ${guardTag};\n`;
}

// The files an owner approval is created and verified with, repo-relative. They
// are read from this checkout, so an uncommitted edit to any of them (a reply
// hook that approves any message, a classifier that stops parking) could launder
// an approval while the migration and PR head stay reviewed (Sol HIGH, PR #857).
// They must match the reviewed commit byte for byte before a request is built or
// an approval honoured.
export const OWNER_TRUST_FILES = Object.freeze([
  ".claude/hooks/owner-approval-lib.mjs",
  ".claude/hooks/owner-approval-prompt.mjs",
  ".claude/hooks/live-testdata-lib.mjs",
  ".claude/hooks/migration-access-lib.mjs",
  ".claude/hooks/migration-apply-lib.mjs",
  ".claude/hooks/migration-landing-gate-lib.mjs",
  ".claude/hooks/codex-push-lib.mjs",
  "scripts/apply-migration-file.mjs",
  "scripts/owner-approve-migration.mjs",
]);
// The checkout these files were loaded from: this module lives in <root>/.claude/hooks.
export const OWNER_TRUST_ROOT = path.resolve(HERE, "..", "..");

const lfHash = (bytes) => createHash("sha256").update(String(bytes).replace(/\r\n/g, "\n")).digest("hex");

/**
 * Throws unless every OWNER_TRUST_FILES file on disk is byte-identical (CRLF→LF,
 * the repository's line-ending normalization) to that file in the reviewed
 * commit `head`. Compares file bytes directly, never `git status`, which trusts
 * the index's cached file times and the assume-unchanged / skip-worktree flags.
 */
export function assertOwnerTrustFilesReviewed({
  head,
  root = OWNER_TRUST_ROOT,
  files = OWNER_TRUST_FILES,
  showCommitted = (rel) => execFileSync("git", ["show", `${head}:${rel}`], {
    cwd: root, encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024,
  }),
  readOnDisk = (rel) => readFileSync(path.join(root, ...rel.split("/")), "utf8"),
} = {}) {
  if (!/^[0-9a-f]{40}$/i.test(String(head || ""))) throw new Error("no reviewed commit to compare the approval files against");
  const changed = [];
  for (const rel of files) {
    let committed;
    try { committed = showCommitted(rel); }
    catch { changed.push(`${rel} (not in the reviewed commit)`); continue; }
    let disk;
    try { disk = readOnDisk(rel); }
    catch { changed.push(`${rel} (missing on disk)`); continue; }
    if (lfHash(disk) !== lfHash(committed)) changed.push(rel);
  }
  if (changed.length) {
    throw new Error(
      `these approval files differ from the reviewed commit ${String(head).slice(0, 12)}: ${changed.join(", ")}. ` +
      "Only the reviewed bytes may create or check Mason's approval; restore them (git checkout -- <file>) and do not edit them locally");
  }
}

/** The approval must still be inside its 30 minutes at the moment of transmission. */
export function assertApprovalStillValid(expiresAt, now = Date.now()) {
  const expires = Date.parse(expiresAt);
  if (!Number.isFinite(expires) || now > expires) throw new Error(`Mason's approval expired at ${expiresAt}`);
}

/** Every approval file for this migration in the given directories. */
export function findOwnerApprovals(dirs, safeName) {
  const found = [];
  for (const dir of dirs || []) {
    const file = path.join(dir, approvalFileName(safeName));
    try { found.push({ dir, file, approval: JSON.parse(readFileSync(file, "utf8")) }); } catch { /* none here */ }
  }
  return found;
}

/**
 * Check one approval against what is about to be applied.
 *
 * @param {object} args
 * @param {{payload: string, approvedAt: string, via: string}} args.approval
 * @param {object} args.expect  project, migration, queryHash, pullRequest, prHead,
 *   categories ([{category, reason}] exactly as parkedCategories returns them now),
 *   sessionId (the Claude Code session running the apply)
 * @param {string[]|null} [args.appliedNames]  the live ledger snapshot; null skips that check
 * @param {Set<string>} [args.usedNonces]
 * @param {(mark: object) => void} [args.checkReply]  throws unless his reply was his words alone (assertReplyAlone)
 * @returns {{ok: true, payload: object, expiresAt: string}|{ok: false, reason: string}}
 */
export function verifyOwnerApproval({ approval, expect, appliedNames = null, usedNonces = new Set(), now = Date.now(), checkReply = assertReplyAlone }) {
  const no = (reason) => ({ ok: false, reason });
  const payloadText = approval?.payload;
  if (typeof payloadText !== "string" || approval?.via !== OWNER_APPROVAL_VIA) return no("the approval file is malformed");

  let p;
  try { p = JSON.parse(payloadText); } catch { return no("the approval is unreadable"); }
  if (p.purpose !== OWNER_APPROVAL_PURPOSE) return no(`the approval is for "${p.purpose}", not a migration approval`);
  if (p.project !== expect.project) return no(`it approves project ${p.project}, not ${expect.project}`);
  if (p.migration !== expect.migration) return no(`it approves ${p.migration}, not ${expect.migration}`);
  if (p.queryHash !== expect.queryHash) return no("the migration file changed after Mason approved it (different fingerprint)");
  // His reply counts only in the conversation that asked him, and that is the one
  // that must apply it (AGENTS.md: approval in the current conversation).
  if (!usableSessionId(expect.sessionId)) return no("the applying session is unknown (fail closed)");
  if (p.sessionId !== expect.sessionId) return no("it was approved in a different conversation than the one applying it; ask Mason here");
  if (!/^[0-9a-f]{40}$/i.test(String(expect.prHead || "")) || !Number.isInteger(Number(expect.pullRequest)) || !(Number(expect.pullRequest) > 0)) {
    return no("the pull request or its head is unknown (fail closed)");
  }
  if (Number(p.pullRequest) !== Number(expect.pullRequest)) return no(`it approves pull request #${p.pullRequest}, not #${expect.pullRequest}`);
  if (String(p.prHead).toLowerCase() !== String(expect.prHead).toLowerCase()) {
    return no(`it approves version ${String(p.prHead).slice(0, 12)}, not the pull request's current head ${String(expect.prHead).slice(0, 12)}`);
  }
  // What Mason was told the check found must be EXACTLY what it finds now — the
  // categories and their reasons, in order. Comparing names alone would let a
  // hand-built request keep the category and soften the reason he reads.
  const shown = (p.categories || []).map((c) => `${c?.category}\u0000${c?.reason}`);
  const actual = (expect.categories || []).map((c) => `${c?.category}\u0000${c?.reason}`);
  const missing = (expect.categories || []).filter((c) => !shown.includes(`${c?.category}\u0000${c?.reason}`));
  if (missing.length) {
    return no(`Mason was not shown that it ${missing.map((c) => PARKED_LABELS[c?.category] || c?.category).join(" and ").toLowerCase()}, in the words the safety check uses`);
  }
  if (shown.length !== actual.length || shown.some((s, i) => s !== actual[i])) {
    return no("what Mason was told the safety check found is not what it finds now");
  }
  if (JSON.stringify(p.summary) !== JSON.stringify(ownerApprovalSummary(p))) return no("what Mason was shown does not match what the approval covers");

  const issued = Date.parse(p.issuedAt);
  const deadline = Date.parse(p.expiresAt);
  const approved = Date.parse(approval.approvedAt);
  if (!Number.isFinite(issued) || !Number.isFinite(deadline) || !Number.isFinite(approved)) return no("the approval has no usable time window");
  if (deadline <= issued || deadline - issued > OWNER_REQUEST_MAX_AGE_MS) return no("the request gave Mason more than 24 hours to reply");
  if (approved < issued) return no("the approval is dated before the request was made");
  if (approved > deadline) return no(`Mason replied after the request expired at ${p.expiresAt}`);
  if (now < approved) return no("the approval is dated in the future");
  const expires = approved + OWNER_APPROVAL_MAX_AGE_MS;
  if (now > expires) return no(`the approval expired at ${new Date(expires).toISOString()}, 30 minutes after Mason replied; ask him again`);
  if (!/^[0-9A-Za-z_-]{1,128}$/.test(String(p.nonce || ""))) return no("the approval has no usable one-time code");
  if (usedNonces.has(String(p.nonce))) return no("this approval was already used; each one works once");
  if (Array.isArray(appliedNames) && appliedNames.includes(expect.migration)) {
    return no(`${expect.migration} is already in the live ledger; an approval covers one install`);
  }
  // His reply, read back now that it is written, was his words alone (Codex P1, PR #900).
  try { checkReply(approval.replyMark); }
  catch (e) { return no(`his reply could not be confirmed as the approval words alone (${errText(e)})`); }
  return { ok: true, payload: p, expiresAt: new Date(expires).toISOString() };
}
