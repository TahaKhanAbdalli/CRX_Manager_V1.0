#!/usr/bin/env node
// Tests for the Codex GitHub App review predicates (2026-09-02).
//
// The failure mode this suite exists to prevent is SILENT: if the login match,
// the oid binding, or the resolution check is wrong, every predicate returns
// "nothing to see here" and every merge sails through looking checked. A green
// run of this file must therefore mean the checks actually fired, so the
// canaries below assert the DENY direction, not only the allow direction.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CODEX_BOT_LOGINS,
  CODEX_THREADS_QUERY,
  CODEX_THREAD_MAX_PAGES,
  CODERABBIT_REQUIRED_LABEL,
  codexBotFindingsDenial,
  coderabbitCompletedCommit,
  coderabbitRequirementArgs,
  coderabbitReviewMissingDenial,
  evaluateCodeRabbitRequirement,
  isMoneyPath,
  prOwnChangesUnchanged,
  readCodeRabbitRequirement,
  codexBotThreads,
  coderabbitFindingsDenial,
  coderabbitThreadCount,
  coderabbitUnreadableDenial,
  collectCodexThreads,
  evaluateCodexBotReview,
  isCodeRabbitLogin,
  isCodexBotLogin,
  isStandingAtHead,
  oidMatchesHead,
  unresolvedCodeRabbitThreads,
} from "./codex-bot-review-lib.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let pass = 0;
function ok(v, m) { assert.ok(v, m); pass++; }
function eq(a, b, m) { assert.deepEqual(a, b, m); pass++; }

const HEAD = "53e9c07142a4428848a3cebc0c31d2c1b83334c9";
const OLD = "306d1e263e0000000000000000000000000000aa";

// Build a GraphQL-shaped reviewThread node.
// A resolved thread carries a reply by default (resolved AND answered is the
// handled state since #973); pass totalCount explicitly to test otherwise, or
// null to omit the field.
const thread = ({ login = "chatgpt-codex-connector", oid = HEAD, resolved = false, totalCount = resolved ? 2 : 1 } = {}) => ({
  isResolved: resolved,
  isOutdated: false,
  comments: { ...(totalCount === null ? {} : { totalCount }), nodes: [{ author: { login }, originalCommit: { oid } }] },
});
const pr = (threads, headRefOid = HEAD) => ({ headRefOid, reviewThreads: { nodes: threads } });

// ── CodeRabbit's unresolved threads (advisory since 2026-10-19) ──────────────
ok(isCodeRabbitLogin("coderabbitai") && isCodeRabbitLogin("coderabbitai[bot]") && isCodeRabbitLogin(" CodeRabbitAI "),
  "both API spellings of CodeRabbit's login match");
ok(!isCodeRabbitLogin("coderabbit") && !isCodeRabbitLogin("chatgpt-codex-connector"), "other logins do not");
eq(unresolvedCodeRabbitThreads(pr([thread({ login: "coderabbitai", oid: OLD })])), 1,
  "an unresolved CodeRabbit thread on an OLDER commit counts — it never re-reviews the fix");
eq(unresolvedCodeRabbitThreads(pr([thread({ login: "coderabbitai", resolved: true, totalCount: 2 })])), 0,
  "a thread resolved WITH a reply is handled");
eq(unresolvedCodeRabbitThreads(pr([thread({ login: "coderabbitai", resolved: true, totalCount: 1 })])), 1,
  "a thread resolved with NO reply still counts as unanswered (Luna rounds 4–6)");
eq(unresolvedCodeRabbitThreads(pr([thread({ login: "coderabbitai", resolved: true, totalCount: null })])), 1,
  "an unknown comment count is treated as no reply");
// A thread whose opening author cannot be read is unreadable, not clean (Luna round 7).
eq(coderabbitThreadCount(pr([{ isResolved: false, comments: null }])), null, "a thread with no readable comments makes the count null");
eq(coderabbitThreadCount(pr([{ isResolved: false, comments: { totalCount: 1, nodes: [{ author: null }] } }])), null,
  "a thread whose author is null makes the count null");
eq(unresolvedCodeRabbitThreads(pr([thread({ login: "coderabbitai", resolved: false, totalCount: 3 })])), 1,
  "a reply alone, without resolving, is still open");
eq(unresolvedCodeRabbitThreads(pr([thread()])), 0, "a Codex App thread is not a CodeRabbit thread");
eq(unresolvedCodeRabbitThreads(pr([thread({ login: "coderabbitai" }), thread({ login: "coderabbitai[bot]", oid: OLD })])), 2,
  "every unresolved CodeRabbit thread is counted");
eq(unresolvedCodeRabbitThreads({}), 0, "no thread data reads as zero (fail-open)");
ok(/CodeRabbit has 2 unresolved comment threads/.test(coderabbitFindingsDenial("X", "5", 2)), "the denial names the count");
// The count the gates act on: null (fail closed) unless the read is complete.
eq(coderabbitThreadCount(pr([])), 0, "a complete read with nothing open is 0");
eq(coderabbitThreadCount(pr([thread({ login: "coderabbitai" })])), 1, "a complete read counts open threads");
eq(coderabbitThreadCount({ ...pr([]), incomplete: true }), null, "a partial read with nothing seen is null — cannot rule a finding out");
eq(coderabbitThreadCount({ ...pr([thread({ login: "coderabbitai" })]), incomplete: true }), 1,
  "a partial read that already shows an open thread still counts it");
eq(coderabbitThreadCount(pr([], "")), null, "no head means nothing was read — null");
eq(coderabbitThreadCount(null), null, "no data at all — null");
eq(coderabbitThreadCount({ headRefOid: HEAD }), null, "a head with no thread list is malformed — null, not a clean 0");
eq(coderabbitThreadCount({ headRefOid: HEAD, reviewThreads: {} }), null, "a thread object with no nodes — null");
// End to end through the pager (Codex App P1 on PR #973): a GraphQL answer with a
// head but a missing or null reviewThreads field must come out INCOMPLETE, so the
// CodeRabbit count is null (fail closed), never a clean 0.
for (const reviewThreads of [undefined, null, {}, { nodes: null }]) {
  const walked = collectCodexThreads(() => ({ headRefOid: HEAD, reviewThreads }));
  eq(walked.incomplete, true, `a page with reviewThreads=${JSON.stringify(reviewThreads)} marks the walk incomplete`);
  eq(coderabbitThreadCount(walked), null, `…and the CodeRabbit count is null for reviewThreads=${JSON.stringify(reviewThreads)}`);
}
eq(coderabbitThreadCount(collectCodexThreads(() => ({ headRefOid: HEAD, reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } } }))), 0,
  "CONTROL: a well-formed empty page through the pager counts 0");
// Only an explicit hasNextPage:false proves the read complete (Luna round 5, HIGH).
for (const pageInfo of [undefined, null, {}, { hasNextPage: null }, { hasNextPage: "false" }]) {
  const walked = collectCodexThreads(() => ({ headRefOid: HEAD, reviewThreads: { nodes: [], pageInfo } }));
  eq(walked.incomplete, true, `pageInfo=${JSON.stringify(pageInfo)} leaves the walk incomplete`);
  eq(coderabbitThreadCount(walked), null, `…so the CodeRabbit count is null for pageInfo=${JSON.stringify(pageInfo)}`);
}
ok(/fail closed/.test(coderabbitUnreadableDenial("X", "5")), "the unreadable denial says it fails closed");

// ── the two spellings of the bot's name ──────────────────────────────────────
// Verified live 2026-09-02 on PR #556: `gh pr view --json reviews` reports
// author.login "chatgpt-codex-connector"; REST .../pulls/556/reviews reports
// user.login "chatgpt-codex-connector[bot]". Matching one and not the other is
// the silent no-op this whole file guards against.
ok(isCodexBotLogin("chatgpt-codex-connector"), "gh/GraphQL spelling (no [bot] suffix) matches");
ok(isCodexBotLogin("chatgpt-codex-connector[bot]"), "REST spelling (with [bot] suffix) matches");
ok(isCodexBotLogin("  Chatgpt-Codex-Connector[BOT]  "), "match is case- and whitespace-insensitive");
ok(!isCodexBotLogin("coderabbitai[bot]"), "a different review bot does not match");
ok(!isCodexBotLogin("masonwells1"), "a human does not match");
ok(!isCodexBotLogin(""), "empty login does not match");
ok(!isCodexBotLogin(undefined), "missing login does not match");
// Substring matching would let an impostor account pass; the list is exact.
ok(!isCodexBotLogin("not-chatgpt-codex-connector"), "MUST NOT MATCH: compared exactly, not by substring");
ok(!isCodexBotLogin("chatgpt-codex-connector-evil"), "MUST NOT MATCH: suffixed impostor login");
eq(CODEX_BOT_LOGINS.length, 2, "both API spellings are pinned");

// ── thread extraction ────────────────────────────────────────────────────────
eq(codexBotThreads(pr([thread()])).length, 1, "a Codex thread is found");
eq(codexBotThreads(pr([thread({ login: "coderabbitai" })])).length, 0, "CodeRabbit's threads are not Codex's");
eq(codexBotThreads(pr([])).length, 0, "no threads yields none");
eq(codexBotThreads({ headRefOid: HEAD }).length, 0, "absent reviewThreads yields none rather than throwing");
eq(codexBotThreads({ headRefOid: HEAD, reviewThreads: { nodes: "x" } }).length, 0, "non-array nodes yields none");
eq(codexBotThreads(pr([{ isResolved: false, comments: { nodes: [] } }])).length, 0, "a thread with no comments has no author and is skipped");

// ── THE BLOCKING CASE: an unresolved thread on the exact head ────────────────
eq(
  evaluateCodexBotReview(pr([thread({ resolved: false, oid: HEAD })])).status,
  "findings-at-head",
  "MUST BLOCK: an unresolved Codex thread raised against the head is standing findings",
);
eq(
  evaluateCodexBotReview(pr([thread({ resolved: false, oid: HEAD })])).unresolvedAtHead,
  1,
  "the count of standing items is reported so the denial can name it",
);
eq(
  evaluateCodexBotReview(pr([
    thread({ resolved: false, oid: HEAD }),
    thread({ resolved: false, oid: HEAD }),
    thread({ resolved: true, oid: HEAD }),
  ])).unresolvedAtHead,
  2,
  "only UNRESOLVED at-head threads are counted",
);
// Oid comparison must be case-insensitive: GitHub renders oids lowercase, but a
// caller could pass an uppercased head.
eq(
  evaluateCodexBotReview({
    headRefOid: HEAD.toUpperCase(),
    reviewThreads: { nodes: [thread({ resolved: false, oid: HEAD })] },
  }).status,
  "findings-at-head",
  "MUST BLOCK: head/oid match is case-insensitive",
);

// ── the non-blocking cases (deliberate fail-open — see the lib header) ───────
eq(
  evaluateCodexBotReview(pr([thread({ resolved: true, oid: HEAD })])).status,
  "clean-at-head",
  "a RESOLVED thread on the head is handled, not standing — resolving is the intended exit",
);
eq(
  evaluateCodexBotReview(pr([thread({ resolved: false, oid: OLD })])).status,
  "stale",
  "an unresolved thread raised against an OLDER commit is a notice, never a block",
);
eq(
  evaluateCodexBotReview(pr([])).status,
  "none",
  "no Codex threads at all is a notice, never a block",
);
eq(
  evaluateCodexBotReview({ headRefOid: HEAD }).status,
  "none",
  "threads never fetched is a notice, never a block — a failed GraphQL call must not deny",
);
// This asymmetry is load-bearing. Measured on the live board 2026-09-02, the
// Codex App re-reviews on essentially every push (#547 had 13 review objects,
// #530 19, #516 23), so a gate keyed to review OBJECTS would have flagged 6 of
// 10 open PRs with no way to ever satisfy it. These assertions are the ones
// that should fail if someone widens the block back out.
ok(
  evaluateCodexBotReview(pr([thread({ resolved: false, oid: OLD })])).status !== "findings-at-head",
  "MUST NOT BLOCK: an older-commit finding must never be reported as standing at the head",
);
ok(
  evaluateCodexBotReview(pr([thread({ resolved: true, oid: HEAD })])).status !== "findings-at-head",
  "MUST NOT BLOCK: a resolved thread must never be reported as standing findings",
);
ok(
  evaluateCodexBotReview(pr([])).status !== "findings-at-head",
  "MUST NOT BLOCK: absent findings must never be reported as standing findings",
);

// ── the empty-oid trap, tested at the primitive ──────────────────────────────
// These MUST be asserted against oidMatchesHead/isStandingAtHead directly.
// Inside evaluateCodexBotReview an empty head returns early, so an emptiness
// test buried in the filter is unreachable — mutation testing on 2026-09-02
// deleted exactly that check and the whole suite stayed green.
ok(!oidMatchesHead("", ""), "MUST NOT MATCH: unknown oid vs unknown head");
ok(!oidMatchesHead("", HEAD), "MUST NOT MATCH: unknown oid vs a real head");
ok(!oidMatchesHead(HEAD, ""), "MUST NOT MATCH: a real oid vs an unknown head");
ok(!oidMatchesHead(undefined, undefined), "MUST NOT MATCH: both sides missing");
ok(!oidMatchesHead("   ", "   "), "MUST NOT MATCH: whitespace-only is still unknown");
ok(oidMatchesHead(HEAD, HEAD), "a real oid matches an identical head");
ok(oidMatchesHead(HEAD.toUpperCase(), HEAD), "oid match is case-insensitive");
ok(oidMatchesHead(` ${HEAD} `, HEAD), "oid match tolerates surrounding whitespace");
ok(!isStandingAtHead({ resolved: false, oid: "" }, ""), "MUST NOT BLOCK: unknown-vs-unknown is not a standing finding");
ok(isStandingAtHead({ resolved: false, oid: HEAD }, HEAD), "unresolved at the head IS a standing finding");
ok(!isStandingAtHead({ resolved: true, replies: 1, oid: HEAD }, HEAD), "MUST NOT BLOCK: resolved and answered at the head is not standing");
ok(isStandingAtHead({ resolved: true, replies: 0, oid: HEAD }, HEAD),
  "resolved with NO reply at the head is still standing — a silent resolve does not clear a finding (Luna round 7)");
eq(evaluateCodexBotReview(pr([thread({ resolved: true, totalCount: 1, oid: HEAD })])).status, "findings-at-head",
  "a Codex App thread resolved without a reply still blocks");

// An unknown oid must never compare equal to a head, in either direction.
eq(
  evaluateCodexBotReview(pr([thread({ resolved: false, oid: "" })])).status,
  "stale",
  "an empty thread oid is unknown, not a match for the head",
);
eq(
  evaluateCodexBotReview({ headRefOid: "", reviewThreads: { nodes: [thread({ oid: "" })] } }).status,
  "stale",
  "MUST NOT MATCH: empty head vs empty oid is not a head-bound finding",
);
eq(
  evaluateCodexBotReview({ headRefOid: "", reviewThreads: { nodes: [thread()] } }).status,
  "stale",
  "an unknown head cannot bind any thread",
);

// ── measured real-board shapes (2026-09-02) ──────────────────────────────────
// PR #449: 24 Codex threads, exactly 1 unresolved, at the head. The point of
// this case is that a PR can carry a long history of worked threads and still
// be correctly reduced to one outstanding item.
const pr449 = [
  ...Array.from({ length: 23 }, () => thread({ resolved: true, oid: OLD })),
  thread({ resolved: false, oid: HEAD }),
];
eq(evaluateCodexBotReview(pr(pr449)).status, "findings-at-head", "PR #449 shape: 23 worked threads + 1 standing at head still blocks");
eq(evaluateCodexBotReview(pr(pr449)).unresolvedAtHead, 1, "PR #449 shape: exactly one item to act on");
eq(evaluateCodexBotReview(pr(pr449)).codexThreads, 24, "PR #449 shape: total Codex threads reported for context");
// PR #530: 40 Codex threads, 40 unresolved, but only 1 anchored to the head.
// Restricting to the head is what keeps the ask actionable instead of a wall.
const pr530 = [
  ...Array.from({ length: 39 }, () => thread({ resolved: false, oid: OLD })),
  thread({ resolved: false, oid: HEAD }),
];
eq(evaluateCodexBotReview(pr(pr530)).unresolvedAtHead, 1, "PR #530 shape: 40 unresolved overall reduces to 1 at the head");

// ── paging (CRX-REV-002 from this PR's own Codex review) ─────────────────────
// A single 100-thread page can hide the one unresolved thread that matters.
{
  const page = (nodes, hasNextPage, endCursor) => ({
    headRefOid: HEAD,
    reviewThreads: { pageInfo: { hasNextPage, endCursor }, nodes },
  });

  // Two pages: the standing finding is on page 2 and MUST be found.
  const calls = [];
  const two = collectCodexThreads((cursor) => {
    calls.push(cursor);
    return cursor === null
      ? page([thread({ resolved: true, oid: HEAD })], true, "c1")
      : page([thread({ resolved: false, oid: HEAD })], false, null);
  });
  eq(calls, [null, "c1"], "the first page is fetched with no cursor, the second with the returned cursor");
  eq(two.reviewThreads.nodes.length, 2, "nodes from both pages are merged");
  eq(
    evaluateCodexBotReview(two).status,
    "findings-at-head",
    "MUST BLOCK: an unresolved thread on the SECOND page is still found",
  );

  // hasNextPage:false stops immediately.
  let n = 0;
  collectCodexThreads(() => { n += 1; return page([], false, null); });
  eq(n, 1, "paging stops when hasNextPage is false");

  // A complete walk is marked complete.
  eq(two.incomplete, false, "a walk that reached hasNextPage:false is complete");

  // A server that claims hasNextPage forever must not spin: bounded by
  // CODEX_THREAD_MAX_PAGES — and the cap leaves the read INCOMPLETE (Codex
  // round 11): pages behind the cap were never fetched, so a clean reading of
  // what was fetched proves nothing.
  let runaway = 0;
  const capped = collectCodexThreads(() => { runaway += 1; return page([thread({ resolved: true, oid: HEAD })], true, `c${runaway}`); });
  eq(runaway, CODEX_THREAD_MAX_PAGES, "paging is bounded by CODEX_THREAD_MAX_PAGES");
  eq(capped.incomplete, true, "hitting the page cap with more pages behind it is an INCOMPLETE read");
  eq(evaluateCodexBotReview(capped).status, "incomplete", "a capped walk whose fetched pages look clean is 'incomplete', never 'clean-at-head'");

  // hasNextPage true but no usable cursor would otherwise refetch page 1 forever.
  let stuck = 0;
  const stuckWalk = collectCodexThreads(() => { stuck += 1; return page([thread({ resolved: true, oid: HEAD })], true, ""); });
  eq(stuck, 1, "an empty endCursor stops paging instead of refetching the same page");
  eq(stuckWalk.incomplete, true, "…and the read is incomplete, because the server said there was more");
  let repeat = 0;
  const repeatWalk = collectCodexThreads(() => { repeat += 1; return page([thread({ resolved: true, oid: HEAD })], true, "same"); });
  eq(repeat, 2, "a repeated endCursor stops paging rather than looping");
  eq(repeatWalk.incomplete, true, "…and that read is incomplete too");
  eq(evaluateCodexBotReview(repeatWalk).status, "incomplete", "a cursor-stuck walk of resolved threads is 'incomplete', not 'clean-at-head'");

  // A failed request mid-walk keeps what was already read — a standing finding
  // that WAS read still blocks — but never passes a partial read off as clean.
  const partial = collectCodexThreads((cursor) =>
    cursor === null ? page([thread({ resolved: false, oid: HEAD })], true, "c1") : null);
  eq(partial.reviewThreads.nodes.length, 1, "a null page ends the walk without discarding earlier nodes");
  eq(partial.incomplete, true, "a null LATER page is an incomplete read");
  eq(evaluateCodexBotReview(partial).status, "findings-at-head", "partial results still block when they carry a standing finding");
  const partialClean = collectCodexThreads((cursor) =>
    cursor === null ? page([thread({ resolved: true, oid: HEAD })], true, "c1") : null);
  eq(
    evaluateCodexBotReview(partialClean).status,
    "incomplete",
    "MUST NOT READ AS CLEAN: a resolved thread on page one and a failed page two is 'incomplete' — the unread page could hold the unresolved one (Codex round 11)",
  );
  const partialEmpty = collectCodexThreads((cursor) => (cursor === null ? page([], true, "c1") : null));
  eq(evaluateCodexBotReview(partialEmpty).status, "incomplete", "no threads on page one plus a failed page two is 'incomplete', not 'none'");
  const firstFail = collectCodexThreads(() => null);
  eq(firstFail.headRefOid, "", "an immediately failed fetch yields an empty head, which reads as 'none'");
  eq(firstFail.incomplete, false, "page ONE failing is 'could not read', which the callers already handle by the empty head — not a partial read");
  eq(evaluateCodexBotReview(firstFail).status, "none", "a total fetch failure is 'none', never a block");
}
// The query must accept a cursor, or paging silently refetches page one.
ok(/\$after\s*:\s*String/.test(CODEX_THREADS_QUERY), "query declares an $after cursor variable");
ok(/after\s*:\s*\$after/.test(CODEX_THREADS_QUERY), "query passes $after to reviewThreads");
ok(/pageInfo\s*{[^}]*hasNextPage/.test(CODEX_THREADS_QUERY), "query selects pageInfo.hasNextPage");
ok(/pageInfo\s*{[^}]*endCursor/.test(CODEX_THREADS_QUERY), "query selects pageInfo.endCursor");

// ── the denial text names the count and the exit ─────────────────────────────
const denial = codexBotFindingsDenial("PR MERGE GATE", "561", 2);
ok(/chatgpt-codex-connector/.test(denial), "denial names the bot so the reader can find the thread");
ok(/gh pr view 561 --comments/.test(denial), "denial carries the exact command to read the findings");
ok(/2 unresolved comments/.test(denial), "denial states how many items are standing");
ok(/RESOLVE the thread/i.test(denial), "denial states the exit, so the gate is satisfiable");
ok(/an unresolved comment\b/.test(codexBotFindingsDenial("X", "1", 1)), "denial is singular for one item");

// ── the query asks for the fields the predicate reads ────────────────────────
// `gh pr view` has no reviewThreads field, so GraphQL is the only route to
// isResolved. If the query stops selecting one of these, the predicate silently
// sees undefined and reports "none" for every PR.
ok(/reviewThreads/.test(CODEX_THREADS_QUERY), "query selects reviewThreads");
ok(/isResolved/.test(CODEX_THREADS_QUERY), "query selects isResolved — the whole point of the thread route");
ok(/originalCommit/.test(CODEX_THREADS_QUERY), "query selects originalCommit, the commit a finding was raised against");
ok(/author/.test(CODEX_THREADS_QUERY), "query selects the comment author, used to tell Codex from CodeRabbit");
ok(/headRefOid/.test(CODEX_THREADS_QUERY), "query selects headRefOid to bind against");

// ── the guard actually calls this, and only findings-at-head denies ──────────
// A predicate nobody wires in is worth nothing; assert the call site exists.
const guardSource = readFileSync(path.join(__dirname, "pr-merge-guard.mjs"), "utf8");
ok(/codex-bot-review-lib\.mjs/.test(guardSource), "pr-merge-guard.mjs imports from codex-bot-review-lib.mjs");
// Assert the CALL SITE, not the name: the import statement alone satisfies a
// bare /evaluateCodexBotReview/ match, so mutation testing was able to replace
// the call with `null` while this assertion stayed green (2026-09-02).
ok(
  /codexVerdict\s*=\s*evaluateCodexBotReview\s*\(/.test(guardSource),
  "pr-merge-guard.mjs assigns the result of an actual evaluateCodexBotReview(...) call — importing the name is not wiring it in",
);
ok(/findings-at-head/.test(guardSource), "pr-merge-guard.mjs branches on the findings-at-head status");
ok(/CODEX_THREADS_QUERY/.test(guardSource), "pr-merge-guard.mjs runs the shared GraphQL query rather than a private copy");
// The notice path must exist too, or the stale/none cases vanish silently and
// the whole "stop ignoring this reviewer" purpose is lost.
// All THREE non-blocking paths must announce themselves. A bare
// /CODEX REVIEW NOTICE/ test is satisfied by any one of them, so mutation
// testing was able to silence the fetch-failure branch — the most important one,
// because that is the case where the reviewer was never consulted at all — with
// the suite still green (2026-09-02).
eq(
  (guardSource.match(/CODEX REVIEW NOTICE/g) || []).length,
  4,
  "pr-merge-guard.mjs prints a notice on all four non-blocking paths (fetch-failed, stale, none, incomplete)",
);
ok(
  /status === "incomplete"/.test(guardSource) && /NOT a clean reading/.test(guardSource),
  "the incomplete-walk path (Codex round 11) says out loud that a partial read is not a clean one",
);
ok(
  /CODEX REVIEW NOTICE: could not read/.test(guardSource),
  "the fetch-failure path says the findings were NOT checked — silence there would look like a clean pass",
);
ok(
  /fails open by design/.test(guardSource),
  "the fetch-failure notice states that this gate fails open, so the reader knows what the silence means",
);
ok(/collectCodexThreads/.test(guardSource), "pr-merge-guard.mjs pages the thread read rather than taking one page");

// ── the Codex-side guard must not be the silent twin (CRX-REV-003) ───────────
// A one-sided guard is the drift AGENTS.md forbids, and a SILENT fail-open there
// is indistinguishable from "the reviewer had nothing to say".
const codexGuardSource = readFileSync(
  path.join(__dirname, "..", "..", ".codex", "hooks", "production-action-guard.mjs"),
  "utf8",
);
ok(/codex-bot-review-lib\.mjs/.test(codexGuardSource), "the Codex guard imports the same shared predicates, not a copy");
ok(
  /codexVerdict\s*=\s*evaluateCodexBotReview\s*\(/.test(codexGuardSource),
  "the Codex guard actually calls evaluateCodexBotReview(...)",
);
ok(/findings-at-head/.test(codexGuardSource), "the Codex guard branches on findings-at-head");
ok(/collectCodexThreads/.test(codexGuardSource), "the Codex guard pages the thread read too");
eq(
  (codexGuardSource.match(/CODEX REVIEW NOTICE/g) || []).length,
  4,
  "the Codex guard prints all four non-blocking notices, matching the Claude guard",
);
ok(
  /status === "incomplete"/.test(codexGuardSource) && /NOT a clean reading/.test(codexGuardSource),
  "the Codex guard's incomplete-walk notice matches the Claude guard's — a one-sided silence there is the drift this file exists to catch",
);

// ── gate ORDERING, pinned on both guards ─────────────────────────────────────
// This pin was INVERTED on 2026-09-03 by Codex round 6, and the reason matters
// more than the direction.
//
// It originally required the App-review check to run FIRST, so an unanswered
// review comment would be the message the reader got rather than "wait for CI".
// That reasoning was about message quality. The cost was a security hole: this
// lookup is advisory, fail-open, and costs up to four `gh` calls each capped at
// 10s, against hook budgets of 15s (Codex) and 30s (Claude). A PreToolUse hook
// killed mid-call emits nothing, and a hook that emits nothing does NOT deny —
// the class PR #502 established. So a slow GitHub could starve every HARD
// denial that came after it: CHANGES_REQUESTED, the green pipeline, the
// risky-diff classification, and the exact-SHA Sol proof.
//
// The advisory therefore runs LAST, at the points where the alternative is
// returning ALLOW anyway. Both properties are pinned below, because each one
// alone is satisfiable by a broken guard:
//   * ordering — every hard denial precedes the advisory, so none can be starved;
//   * REACHABILITY — the advisory is still actually invoked, or this is the dead
//     code the original pin existed to prevent (it sat behind the Codex guard's
//     approval deny and never ran for any PR without a formal approval).
// Measured at the CALL, not the definition: `function codexAppAdvisory({ request`
// matches the same prefix and now sits textually before the call, so a bare
// indexOf would measure the wrong thing and pass no matter where the call lands.
//
// There are TWO call sites since Codex round 9: the GitHub-connector merge tool
// (one PR per call, so its allow point is right there) and the shell drain
// after the segment loop. The ordering pins below measure the LAST one — the
// shell drain — because that is the one a regression would move back inside
// the loop; the connector site is pinned separately for reachability.
const codexAdvisoryCallAt = codexGuardSource.lastIndexOf("const advisory = codexAppAdvisory({ request");
const codexConnectorAdvisoryAt = codexGuardSource.indexOf("codexAppAdvisory({ request: result.advisoryRequest");
const codexConnectorRouteAt = codexGuardSource.indexOf("if (GITHUB_MERGE_TOOL.test(name)) {");
ok(
  codexConnectorRouteAt > 0 && codexConnectorAdvisoryAt > codexConnectorRouteAt,
  "REACHABILITY (Codex round 9): the GitHub-connector merge route runs the advisory itself — after round 8 deferred the lookup out of the per-merge gate, this route returned the deferred request untouched and a connector-driven merge skipped the check a shell merge got",
);
const codexVerdictMatch = codexGuardSource.match(
  /if \((?:!pullRequestApproved\(pullRequest\)|pullRequestReviewBlocked\(pullRequest\))\)/,
);
ok(codexVerdictMatch, "the Codex guard still has a review-verdict deny to order against");
const codexApprovalAt = codexVerdictMatch.index;
const codexGreenAt = codexGuardSource.indexOf("if (!pullRequestChecksGreen(pullRequest))");
const codexProofAt = codexGuardSource.indexOf("gateMainChange({");
ok(
  codexAdvisoryCallAt > 0 && codexApprovalAt > 0 && codexGreenAt > 0 && codexProofAt > 0,
  "all four Codex-guard gates are present to order",
);
ok(
  codexAdvisoryCallAt > codexApprovalAt,
  "MUST RUN LAST: the Codex guard's advisory lookup follows its review-verdict deny, or a slow GitHub can starve that deny and the hook denies nothing",
);
ok(
  codexAdvisoryCallAt > codexGreenAt,
  "MUST RUN LAST: the Codex guard's advisory lookup follows its green-pipeline deny",
);
ok(
  codexAdvisoryCallAt > codexProofAt,
  "MUST RUN LAST: the Codex guard's advisory lookup follows the exact-SHA proof gate",
);
// REACHABILITY — the advisory must be invoked on the allow path, not merely defined.
ok(
  /if \(mainVerdict\.blocked\) return mainVerdict;/.test(codexGuardSource),
  "the Codex guard returns a hard denial before reaching the advisory",
);
ok(
  /const advisory = codexAppAdvisory\(/.test(codexGuardSource)
  && /if \(advisory\) return advisory;/.test(codexGuardSource),
  "the Codex guard still ACTS on the advisory verdict — defining it without returning it is the dead code this pin exists to catch",
);
// DEFERRED PAST THE WHOLE COMMAND (Codex round 8, SEC-001). Running last within
// one merge was not enough: `gh pr merge 1 && gh pr merge 2` gates each segment
// in turn, so an advisory for #1 run inside the loop still preceded #2's hard
// checks. The call must sit AFTER the segment loop, and the per-merge gate must
// hand its request back rather than call the advisory itself.
const codexSegmentLoopAt = codexGuardSource.indexOf("for (const segment of commandSegments)");
ok(codexSegmentLoopAt > 0, "the Codex guard's segment loop is present to order");
ok(
  codexAdvisoryCallAt > codexSegmentLoopAt,
  "MUST RUN AFTER EVERY MERGE: the Codex guard's advisory call sits after the segment loop, not inside the per-merge gate",
);
ok(
  /return \{ blocked: false, advisoryRequest: request \};/.test(codexGuardSource),
  "the per-merge gate returns its request for deferral instead of running the advisory itself",
);
ok(
  /deferredAdvisories\.push\(result\.advisoryRequest\)/.test(codexGuardSource),
  "the segment loop actually queues the returned request — a gate that hands it back to a caller that drops it is the dead code this pin exists to catch",
);
ok(
  // Capped by the hard-gate deadline since #973 (the lookup now fails closed).
  /const advisoryDeadlineMs = Math\.min\(clock\(\) \+ CODEX_ADVISORY_BUDGET_MS, hardGateDeadlineMs\);/.test(codexGuardSource)
  && /deadlineMs: advisoryDeadlineMs/.test(codexGuardSource),
  "one deadline is computed once and shared by every deferred lookup, so N merges cannot multiply the budget",
);

// The Claude guard now defines codexAdvisory() above gateRequest, so ordering
// must be measured at the CALL SITES. Measuring the definition would compare the
// wrong thing and pass no matter where the call lands.
//
// Since Codex round 8 the allow point QUEUES the request and a single call site
// after the request loop drains the queue. Since Mason's autonomous-landing rule
// (2026-09-26) every main merge needs the exact-SHA Sol proof, so there is ONE
// allow point, behind that proof — the old non-risky allow point, which returned
// before the proof section, is gone. Mason's documentation-only exemption
// (2026-10-07) adds the second and last: reached only when the proof scan found
// nothing, and only for a docs-only diff (sol-exempt-lib.mjs). The pins are:
// exactly two pushes, both after every hard gate and the proof section; the one
// call site sits after the loop.
const claudeQueuePushes = [...guardSource.matchAll(/advisoryQueue\.push\(request\);/g)].map((m) => m.index);
const claudeAdvisoryCalls = [...guardSource.matchAll(/codexAdvisory\(request, advisoryDeadlineMs\);/g)].map((m) => m.index);
const claudeGreenAt = guardSource.indexOf("green-pipeline requirement");
const claudeProofAt = guardSource.indexOf("every main merge → require the fresh, bound Sol proof");
const claudeRequestLoopAt = guardSource.indexOf("for (const request of requests) gateRequest(request);");
eq(
  claudeQueuePushes.length,
  2,
  "the Claude guard has exactly TWO allow points — the Sol proof and the documentation-only exemption; a third would be a merge path that skips both",
);
eq(
  claudeAdvisoryCalls.length,
  1,
  "the Claude guard drains the advisory queue from exactly ONE call site — a second, in-loop call would reintroduce the chained-merge starvation",
);
ok(claudeGreenAt > 0 && claudeProofAt > 0 && claudeRequestLoopAt > 0, "both Claude-guard hard gates and the request loop are present to order");
ok(
  claudeQueuePushes.every((at) => at > claudeGreenAt),
  "MUST RUN LAST: every Claude-guard allow point follows the green-pipeline deny",
);
ok(
  claudeAdvisoryCalls[0] > claudeRequestLoopAt,
  "MUST RUN AFTER EVERY MERGE: the Claude guard drains the advisory queue only after the loop has gated every request",
);
ok(
  /const advisoryDeadlineMs = Date\.now\(\) \+ CODEX_ADVISORY_BUDGET_MS;/.test(guardSource),
  "the Claude guard computes one shared deadline for the whole queue",
);
// Every merge now reaches the proof gate, so the single allow point must follow
// it as well as the green gate. (CodeRabbit's approval check was removed
// 2026-10-19 when Mason made CodeRabbit advisory.)
ok(
  claudeQueuePushes.every((at) => at > claudeProofAt && at > claudeGreenAt),
  "MUST RUN LAST: both allow points follow the green-pipeline gate and the exact-SHA proof gate",
);

// ── the lookup is BOUNDED, on both guards ────────────────────────────────────
// Ordering alone stops the advisory from starving a hard denial. The deadline is
// what stops it from burning the whole hook budget and killing the process
// before it can print its own notices.
for (const [label, source] of [["Claude", guardSource], ["Codex", codexGuardSource]]) {
  const budgetMatch = source.match(/const CODEX_ADVISORY_BUDGET_MS = ([\d_]+);/);
  ok(budgetMatch, `the ${label} guard declares an advisory time budget`);
  const budgetMs = Number(budgetMatch[1].replace(/_/g, ""));
  // Hook budgets: 15s for the Codex guard (.codex/hooks.json), 30s for the
  // Claude guard (.claude/settings.json). Half is the ceiling, so the hard gates
  // and the notices always have room left.
  const hookBudgetMs = label === "Codex" ? 15_000 : 30_000;
  ok(
    budgetMs > 0 && budgetMs <= hookBudgetMs / 2,
    `the ${label} guard's advisory budget (${budgetMs}ms) must stay at or under half its ${hookBudgetMs}ms hook timeout`,
  );
  ok(
    // The Claude guard passes a tighter deadline (one capped call earlier) since #1009.
    /collectCodexThreads\([\s\S]{0,2000}?\{ deadlineMs(?:: deadlineMs - REQUIREMENT_CALL_TIMEOUT_MS)?(?:, now: clock)? \}\)/.test(source),
    `the ${label} guard actually PASSES the deadline to collectCodexThreads — declaring a budget it never applies is decoration`,
  );
}

// The deadline must THROW, never return a partial read: a truncated walk that
// reports "nothing standing" is indistinguishable from a clean one.
let deadlineThrew = false;
try {
  collectCodexThreads(() => ({ headRefOid: "a".repeat(40), reviewThreads: { nodes: [], pageInfo: {} } }), {
    deadlineMs: 1_000,
    now: () => 2_000,
  });
} catch {
  deadlineThrew = true;
}
ok(deadlineThrew, "an exceeded deadline THROWS (callers turn that into their fail-open notice) rather than returning a partial read as clean");

// …and a deadline in the future does not interfere with an ordinary walk.
eq(
  collectCodexThreads(() => ({ headRefOid: "b".repeat(40), reviewThreads: { nodes: [], pageInfo: {} } }), {
    deadlineMs: 10_000,
    now: () => 1_000,
  }).headRefOid,
  "b".repeat(40),
  "a deadline that has not passed leaves the walk untouched",
);

// ── Money PRs need a completed CodeRabbit review of the head (2026-10-21) ────
const MID = "4a1b2c3d4e5f60718293a4b5c6d7e8f901234567";
const crStatus = (description, { login = "coderabbitai", state = "SUCCESS", context = "CodeRabbit" } = {}) =>
  ({ context, state, description, creator: { login } });
const commit = (oid, { parents = 1, statuses = [] } = {}) =>
  ({ commit: { oid, parents: { totalCount: parents }, status: statuses === null ? null : { contexts: statuses } } });
const facts = ({ files = ["src/lib/invoiceMath.ts"], labels = [], commits = [commit(HEAD, { statuses: [crStatus("Review completed")] })],
  headRefOid = HEAD, filesTotal = files.length } = {}) => ({
  headRefOid,
  labels: { totalCount: labels.length, nodes: labels.map((name) => ({ name })) },
  files: { totalCount: filesTotal, nodes: files.map((filePath) => ({ path: filePath })) },
  commits: { totalCount: commits.length, nodes: commits },
});

// Which PRs qualify.
ok(isMoneyPath("src/lib/invoiceMath.ts") && isMoneyPath("src/pages/Inventory.tsx") && isMoneyPath("src\\lib\\prepayApply.ts"),
  "src money/inventory paths qualify, either slash");
ok(isMoneyPath("src/lib/chemCalculator.ts"), "the chemical calculator (quantities x unit prices) qualifies (Sol, PR #1009)");
ok(isMoneyPath("supabase/migrations/20261021000000_anything.sql") && isMoneyPath("supabase/functions/send-email/index.ts"),
  "every migration and Edge Function qualifies");
ok(!isMoneyPath("docs/reference/invoices.md") && !isMoneyPath(".claude/hooks/x.mjs") && !isMoneyPath("src/lib/pagedRead.ts")
  && !isMoneyPath("src/components/Map.tsx"), "docs, hooks and non-money src files do not");
eq(evaluateCodeRabbitRequirement(facts({ files: ["docs/x.md", "src/components/Map.tsx"], commits: [commit(HEAD)] })).status,
  "not-required", "a non-money PR with no label is not gated");
eq(evaluateCodeRabbitRequirement(facts({ files: ["docs/x.md"], labels: [CODERABBIT_REQUIRED_LABEL], commits: [commit(HEAD)] })).status,
  "missing", "the needs-coderabbit label makes any PR qualify");
eq(evaluateCodeRabbitRequirement(facts({ files: ["docs/x.md"], filesTotal: 250, commits: [commit(HEAD)] })).status,
  "missing", "a cut-short file list cannot prove the PR is not a money PR");

// The DENY direction: a money PR with no completed review is refused.
eq(evaluateCodeRabbitRequirement(facts({ commits: [commit(HEAD)] })).status, "missing", "no CodeRabbit status at all is missing");
for (const description of ["Review rate limited", "Review skipped: incremental reviews are disabled", "Review in progress"]) {
  eq(evaluateCodeRabbitRequirement(facts({ commits: [commit(HEAD, { statuses: [crStatus(description)] })] })).status,
    "missing", `"${description}" is not a completed review`);
}
eq(evaluateCodeRabbitRequirement(facts({ commits: [commit(HEAD, { statuses: [crStatus("Review completed", { login: "masonwells1" })] })] })).status,
  "missing", "a 'Review completed' status posted by anyone but CodeRabbit (an agent via Mason's account) does not count");
eq(evaluateCodeRabbitRequirement(facts({ commits: [commit(HEAD, { statuses: [crStatus("Review completed", { context: "CodeRabbit-fake" })] })] })).status,
  "missing", "another context name does not count");
eq(evaluateCodeRabbitRequirement(facts({ commits: [commit(HEAD, { statuses: [crStatus("Review completed", { state: "PENDING" })] })] })).status,
  "missing", "a non-success state does not count");
eq(evaluateCodeRabbitRequirement(facts({ commits: [commit(OLD, { statuses: [crStatus("Review completed")] }), commit(HEAD)] })).status,
  "missing", "an ordinary commit after the reviewed one needs a new review");

// The ALLOW direction.
const reviewedHead = evaluateCodeRabbitRequirement(facts());
eq([reviewedHead.status, reviewedHead.reviewedOid], ["reviewed", HEAD], "a completed review of the head passes");
eq(evaluateCodeRabbitRequirement(facts({ commits: [commit(OLD, { statuses: [crStatus("Review completed")] }),
  commit(MID, { parents: 2 }), commit(HEAD, { parents: 2, statuses: [crStatus("Review skipped: incremental reviews are disabled")] })] })).status,
  "reviewed", "only merge commits after the reviewed commit keep the earlier review");
ok(coderabbitCompletedCommit({ status: { contexts: [crStatus("Review completed", { login: "coderabbitai[bot]" })] } }),
  "both CodeRabbit login spellings count");

// Unreadable answers fail closed.
eq(evaluateCodeRabbitRequirement(null).status, "unreadable", "no data is unreadable");
eq(evaluateCodeRabbitRequirement({ headRefOid: HEAD }).status, "unreadable", "missing lists are unreadable");
// A partial answer is never "not required" (Sol, PR #1009).
{
  const partialFiles = facts({ files: ["docs/x.md"], commits: [commit(HEAD)] });
  partialFiles.files.nodes.push({ path: null });
  partialFiles.files.totalCount = 2;
  eq(evaluateCodeRabbitRequirement(partialFiles).status, "unreadable", "a file entry with no path is unreadable, not exempt");
  const partialLabels = facts({ files: ["docs/x.md"], commits: [commit(HEAD)] });
  partialLabels.labels = { totalCount: 1, nodes: [{ name: null }] };
  eq(evaluateCodeRabbitRequirement(partialLabels).status, "unreadable", "a label entry with no name is unreadable, not exempt");
  let threw = false;
  try {
    readCodeRabbitRequirement(() => JSON.stringify({ errors: [{ message: "partial" }],
      data: { repository: { pullRequest: facts({ files: ["docs/x.md"], commits: [commit(HEAD)] }) } } }), { owner: "o", name: "r", number: 1 });
  } catch { threw = true; }
  ok(threw, "a GraphQL answer carrying errors is refused even when it includes data");
}
eq(evaluateCodeRabbitRequirement(facts({ commits: [commit(OLD, { statuses: [crStatus("Review completed")] })] })).status,
  "unreadable", "a commit list that does not end at the head is not trusted");
eq(evaluateCodeRabbitRequirement(facts({ commits: [] })).status, "unreadable", "an empty commit list is not trusted");

// A label list cut short cannot prove the label is absent (Luna round 5).
eq(evaluateCodeRabbitRequirement({ ...facts({ files: ["docs/x.md"], commits: [commit(HEAD)] }),
  labels: { totalCount: 150, nodes: [] } }).status, "missing", "an incomplete label list makes the PR qualify");

// The merge walk is only provisional (Luna round 5, BLOCKER): the PR's own
// changes must be byte-identical at the reviewed commit and at the head.
const BASE40 = "b".repeat(40);
const walkFacts = { ...facts({ commits: [commit(OLD, { statuses: [crStatus("Review completed")] }), commit(HEAD, { parents: 2 })] }), baseRefOid: BASE40 };
const prFiles = [{ filename: "src/lib/invoiceMath.ts", status: "modified", sha: "1".repeat(40) }];
const fakeGh = ({ atReview = prFiles, atHead = prFiles, onCall = () => {} } = {}) => (args) => {
  onCall(args);
  const target = String(args[1] || "");
  if (args[1] === "graphql") return JSON.stringify({ data: { repository: { pullRequest: walkFacts } } });
  if (target.includes("/files?per_page")) return "src/lib/invoiceMath.ts\t\n";
  if (target.endsWith(`...${OLD}`)) return JSON.stringify(atReview);
  if (target.endsWith(`...${HEAD}`)) return JSON.stringify(atHead);
  throw new Error(`unexpected gh ${args.join(" ")}`);
};
const read = (gh, extra = {}) => readCodeRabbitRequirement(gh, { owner: "o", name: "r", number: 9, ...extra });
eq(read(fakeGh()).status, "reviewed", "a merge-only walk with identical PR changes keeps the earlier review");
eq(read(fakeGh({ atHead: [{ ...prFiles[0], sha: "2".repeat(40) }] })).status, "missing",
  "a merge that changed a PR file voids the earlier review");
eq(read(fakeGh({ atHead: [...prFiles, { filename: "src/lib/newMoney.ts", status: "added", sha: "3".repeat(40) }] })).status, "missing",
  "a merge that added a file to the PR's own changes voids the earlier review");
{
  // Identical on both sides, so only the cap can refuse it.
  const capped = Array.from({ length: 300 }, (_, i) => ({ filename: `f${i}`, status: "modified", sha: "4".repeat(40) }));
  eq(read(fakeGh({ atReview: capped, atHead: capped })).status,
    "missing", "a compare at GitHub's 300-file cap cannot prove anything, even when both sides match");
}
ok(read(fakeGh({ onCall: (args) => ok(!String(args[1]).includes("compare/") || /compare\/b{40}\.\.\./.test(args[1]), "compares against the PR's base") })),
  "the compare is three-dot against the PR's base");
eq(prOwnChangesUnchanged(null, prFiles), false, "an unreadable compare is never 'unchanged'");
{
  const renamed = (from) => [{ filename: "src/lib/newName.ts", status: "renamed", sha: "5".repeat(40), previous_filename: from }];
  eq(prOwnChangesUnchanged(renamed("src/lib/a.ts"), renamed("src/lib/a.ts")), true, "the same rename is unchanged");
  eq(prOwnChangesUnchanged(renamed("src/lib/a.ts"), renamed("src/lib/b.ts")), false,
    "a rename from a different source path is a different change (Codex App P2)");
}
// A review AT the head needs no compare at all.
{
  let calls = 0;
  const headGh = (args) => {
    calls += 1;
    if (args[1] === "graphql") return JSON.stringify({ data: { repository: { pullRequest: { ...facts(), baseRefOid: BASE40 } } } });
    if (String(args[1]).includes("/files?per_page")) return "src/lib/invoiceMath.ts\t";
    throw new Error("no compare expected");
  };
  eq(read(headGh).status, "reviewed", "a review of the head passes");
  eq(calls, 2, "…with the GraphQL read and the file list only (no compare)");
}
// A money file renamed to a generic name and edited still qualifies (Sol, PR #1009):
// GraphQL reports only the new path; the REST list names the source too.
{
  const renameFacts = { ...facts({ files: ["src/lib/math.ts"], commits: [commit(HEAD)] }), baseRefOid: BASE40 };
  const renameGh = (rows) => (args) => (args[1] === "graphql"
    ? JSON.stringify({ data: { repository: { pullRequest: structuredClone(renameFacts) } } })
    : rows);
  eq(read(renameGh("src/lib/math.ts\tsrc/lib/invoiceMath.ts\n")).status, "missing",
    "invoiceMath.ts renamed to math.ts qualifies through its source path");
  eq(read(renameGh("src/lib/math.ts\t\n")).status, "not-required", "CONTROL: the same generic file with no money source does not");
  eq(read(renameGh("src/lib/math.ts\t\nsrc/lib/other.ts\t\n")).status, "missing",
    "a REST list whose count disagrees with GitHub's total cannot prove the PR exempt");
}
// A PR with more than 100 files: the full list is read over REST (Luna round 6).
{
  const big = Array.from({ length: 150 }, (_, i) => `docs/page-${i}.md`);
  const bigFacts = { ...facts({ files: big.slice(0, 100), filesTotal: 150, commits: [commit(HEAD)] }), baseRefOid: BASE40 };
  const bigGh = (list) => (args) => (args[1] === "graphql"
    ? JSON.stringify({ data: { repository: { pullRequest: structuredClone(bigFacts) } } })
    : list.join("\n"));
  eq(read(bigGh(big)).status, "not-required", "a 150-file docs PR is read in full and stays advisory");
  eq(read(bigGh([...big.slice(0, 149), "src/lib/invoiceMath.ts"])).status, "missing",
    "…but a money file on a later page still makes it qualify");
  eq(read(bigGh(big.slice(0, 120))).status, "missing", "a full list whose count does not match stays incomplete (fail closed)");
}

// Budget: a call is not started unless it can finish before the deadline.
{
  let threw = false;
  try { read(fakeGh(), { deadlineMs: 10_000, callTimeoutMs: 5_000, now: () => 6_000 }); } catch { threw = true; }
  ok(threw, "a call that could outlive the budget is not started — the read throws (callers refuse)");
  eq(read(fakeGh(), { deadlineMs: 10_000, callTimeoutMs: 5_000, now: () => 1_000 }).status, "reviewed",
    "a call that fits the budget runs");
}

// The query and denial carry what the agent needs.
ok(coderabbitRequirementArgs("o", "r", 5).includes("number=5")
  && /status \{ contexts \{ context state description creator/.test(coderabbitRequirementArgs("o", "r", 5)[3]),
  "the query reads each commit's status contexts with their creator");
ok(/@coderabbitai full review/.test(coderabbitReviewMissingDenial("X", "7", "it changes money", HEAD))
  && /pr comment 7/.test(coderabbitReviewMissingDenial("X", "7", "w", HEAD)),
  "the denial tells the agent the exact one request to post");

console.log(`codex-bot-review-lib: ${pass} assertions passed`);
