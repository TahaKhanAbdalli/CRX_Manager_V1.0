// Shared predicates for the Codex GitHub App's automated pull-request review
// (`chatgpt-codex-connector`), so the merge gates can stop treating it as
// invisible. Added 2026-09-02.
//
// WHY THIS EXISTS
// ---------------
// The Codex App has been reviewing every PR in this repo since it was enabled
// in the ChatGPT Codex cloud settings, and NOTHING in this repository read its
// output: a grep for `chatgpt-codex-connector` across hooks, skills, commands,
// scripts and docs returned zero hits before this file. It posts a summary
// comment and, when it has suggestions, a real review — into a void.
//
// That was survivable while main required an approval CodeRabbit had to grant.
// It stopped being survivable on 2026-09-02, when the Claude-side merge gate
// downgraded "no current approval" from a deny to a printed notice. An
// automated review that nobody reads is now worse than no review: it renders a
// green check on the PR page that reads as coverage.
//
// THE TWO SPELLINGS OF THE BOT'S NAME  (both verified live 2026-09-02)
// -------------------------------------------------------------------
//   `gh pr view --json reviews`  -> author.login === "chatgpt-codex-connector"
//   REST .../pulls/<n>/reviews   -> user.login   === "chatgpt-codex-connector[bot]"
// Matching one spelling and not the other is the silent-failure mode for this
// whole file: the predicate finds no bot reviews, reports "nothing to see", and
// every merge sails through looking checked. Both spellings are pinned in the
// tests, and the GraphQL thread path uses the bare spelling.
//
// WHY THIS READS THREADS, NOT REVIEW OBJECTS  (measured, not assumed)
// -------------------------------------------------------------------
// The first cut of this file blocked on "the bot submitted a COMMENTED review
// whose commit oid is the head". Running that against all 10 open PRs on
// 2026-09-02 flagged SIX of them, which sent me to look at why:
//
//   PR #547  13 Codex reviews, one per commit, newest at the head
//   PR #530  19 Codex reviews, newest at the head
//   PR #516  23 Codex reviews, newest at the head
//
// The App's own "About Codex in GitHub" blurb lists its triggers as PR-opened,
// draft-marked-ready, and an `@codex review` comment — it does NOT mention
// pushes. The blurb is not what the App actually does: it re-reviews on
// essentially every push. So a COMMENTED review object sitting on the head is
// the ORDINARY state of an active PR, not a signal that anything is wrong.
//
// Worse, a review object has no exit. You cannot resolve one; the bot simply
// posts another on the next push. A gate keyed to it could never be satisfied —
// exactly the deadlock that got main's required review relaxed the day before.
//
// The signal that carries real information is the REVIEW THREAD, and its
// `isResolved` flag. Same six PRs, counted at thread level:
//
//   PR   codexThreads  codexUnresolved  unresolvedAtHead
//   449      24              1                1
//   530      40             40                1
//   535       7              7                2
//   547      19              1                1
//   556       1              1                1
//   544       5              5                1
//
// PRs #449 and #547 show 24 and 19 Codex threads with ONE unresolved each:
// people really do work these threads, so resolution state distinguishes
// "handled" from "standing". And the gate's unit of work is 1-2 items with a
// clear exit — fix it, or resolve the thread with a reason.
//
// DELIBERATE FAIL-OPEN — READ BEFORE "HARDENING" THIS
// @speed-bump — this layer raises the cost of merging over an unread Codex
// finding. It is NOT a boundary, and nothing here should be described as one.
// ---------------------------------------------------
// @speed-bump — the surrounding hard gates (CI's required checks, the exact-SHA
// gpt-5.6-sol proof) are the boundary; this predicate never carries that weight.
// Almost every other predicate in this repo fails closed. This one does not,
// and that is deliberate (Mason chose the narrow-block option on 2026-09-02).
// This layer is an honest-mistake net for an ADVISORY reviewer; the hard gates
// are elsewhere and unchanged — CI's required checks, and the exact-SHA
// `gpt-5.6-sol` proof `pr-merge-guard.mjs` demands for a risky diff. So every
// uncertainty here degrades to a loud notice, never to a locked door:
//
//   findings-at-head : >=1 UNRESOLVED Codex thread anchored to THIS head
//                      -> DENY. It flagged this exact code and nobody
//                         answered. Exit: fix it, or resolve the thread.
//   stale            : it has threads, but none unresolved at this head -> NOTICE
//   none             : no Codex threads / the data could not be fetched -> NOTICE
//   clean-at-head    : it reviewed this head and nothing is outstanding -> silent
//
// Thread reads page up to CODEX_THREAD_MAX_PAGES (see collectCodexThreads).
// Beyond that a PR could hide an unresolved thread, which loses a DENY rather
// @speed-bump — losing a DENY is the failure mode; this is not a boundary.
// than inventing one — the safe direction for a fail-open gate.

// Both API spellings, lowercased. `[bot]` is a suffix GitHub's REST API adds
// and `gh`/GraphQL strip; neither is more canonical than the other.
export const CODEX_BOT_LOGINS = Object.freeze([
  "chatgpt-codex-connector",
  "chatgpt-codex-connector[bot]",
]);

// GraphQL page size for reviewThreads. 100 is GitHub's per-page maximum, so
// covering a longer PR means paging, not a bigger number.
export const CODEX_THREAD_PAGE_SIZE = 100;

// How many pages collectCodexThreads() will walk. Three pages = 300 threads,
// which clears every PR on this board by a wide margin (the largest, #530, has
// 48) while keeping the worst case to three API calls inside a hook that must
// answer quickly. Running out of pages loses a DENY rather than inventing one.
export const CODEX_THREAD_MAX_PAGES = 3;

export function isCodexBotLogin(login) {
  return CODEX_BOT_LOGINS.includes(String(login || "").trim().toLowerCase());
}

// The GraphQL query the guards run to get thread resolution state. `gh pr view`
// has no `reviewThreads` field (verified 2026-09-02: "Unknown JSON field"), so
// this is the only route to `isResolved`.
//
// `originalCommit.oid` is the commit the thread was FIRST left on, which is what
// "flagged this exact code" means. GitHub re-anchors older comments onto newer
// heads for display, so the thread's displayed position is not evidence of when
// it was raised.
export const CODEX_THREADS_QUERY = `
query($owner:String!, $name:String!, $number:Int!, $first:Int!, $after:String) {
  repository(owner:$owner, name:$name) {
    pullRequest(number:$number) {
      headRefOid
      reviewThreads(first:$first, after:$after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          isResolved
          isOutdated
          comments(first:1) { totalCount nodes { author { login } originalCommit { oid } } }
        }
      }
    }
  }
}`;

// Walk up to CODEX_THREAD_MAX_PAGES pages of review threads and return a single
// pullRequest-shaped object for evaluateCodexBotReview().
//
// `runQuery(cursor)` performs one GraphQL request and returns the parsed
// `pullRequest` node (or null/undefined). The caller owns transport, so the
// Claude and Codex guards can each use their own gh runner without forking this
// paging logic.
//
// Added after a Codex review of this file's own PR flagged the unpaginated
// single-page read (CRX-REV-002): on a PR with more than 100 threads the
// unresolved one could sit on a page nobody fetched, and the gate would report
// "nothing standing" while something was.
// `deadlineMs` is an ABSOLUTE epoch-millisecond cap on the whole walk, checked
// before every request including the first. Exceeding it THROWS rather than
// returning what has been read so far: a partial read is indistinguishable from
// @proven-by codex-bot-review-lib.test.mjs — "an exceeded deadline THROWS
// (callers turn that into their fail-open notice) rather than returning a
// partial read as clean"
// a clean one, and this predicate's callers turn a throw into their fail-open
// notice. Returning early with `nodes` would instead report "nothing standing"
// while a finding sat on an unfetched page — the exact defect CRX-REV-002 fixed.
//
// It exists because this lookup runs inside a PreToolUse hook with a hard outer
// timeout (15s for the Codex guard, 30s for Claude's). A hook killed mid-call
// emits nothing, and a PreToolUse hook that emits nothing does NOT deny — so an
// @speed-bump — the deadline keeps this advisory from starving the hard gates;
// the budget is a cost control, not a boundary of its own.
// unbounded advisory lookup is a fail-open on every HARD gate that would have
// run after it (PR #502 established this class; Codex round 6 found this
// instance). The callers additionally run this only after their hard denials,
// so the ordering does not depend on this budget being right.
//
// `incomplete` (Codex round 11, Medium): the walk can also END without
// concluding — a later page comes back null, the server claims hasNextPage
// with no usable cursor, or the page cap is reached with more pages behind
// it. Those used to return what had been read as if it were everything, so a
// resolved thread on page one plus an unresolved one on page four read as
// "clean-at-head". The result now carries `incomplete: true` on every such
// path, and evaluateCodexBotReview() refuses to call an incomplete read clean:
// a standing finding it DID see still blocks, but anything short of that is
// reported as "incomplete" so the callers print a notice instead of nothing.
export function collectCodexThreads(runQuery, { deadlineMs = null, now = Date.now } = {}) {
  let cursor = null;
  let headRefOid = "";
  const nodes = [];
  let incomplete = false;
  for (let page = 0; page < CODEX_THREAD_MAX_PAGES; page += 1) {
    if (deadlineMs !== null && now() >= deadlineMs) {
      throw new Error("codex-bot review lookup exceeded its time budget before it could finish paging");
    }
    const pr = runQuery(cursor);
    if (!pr) {
      // Page one failing is "could not read at all" (empty head, handled by
      // the callers); a LATER page failing leaves a partial read.
      if (page > 0) incomplete = true;
      break;
    }
    if (!headRefOid) headRefOid = String(pr.headRefOid || "");
    const threads = pr?.reviewThreads;
    // A page with no thread list (a partial or malformed GraphQL answer) is NOT
    // an empty page: mark the walk incomplete so it is never read as "nothing
    // open" (Codex App review of PR #973, P1).
    if (!Array.isArray(threads?.nodes)) {
      incomplete = true;
      break;
    }
    nodes.push(...threads.nodes);
    // Only an explicit `hasNextPage: false` ends the walk as COMPLETE; a missing
    // or malformed pageInfo cannot prove there is nothing more (Luna round 5).
    const hasNextPage = threads?.pageInfo?.hasNextPage;
    if (hasNextPage === false) break;
    if (hasNextPage !== true) {
      incomplete = true;
      break;
    }
    const next = String(threads?.pageInfo?.endCursor || "");
    // No cursor but "hasNextPage" would loop forever on the same page — and
    // there IS more, which this walk cannot reach.
    if (!next || next === cursor) {
      incomplete = true;
      break;
    }
    cursor = next;
    // The cap is about to end the walk while the server still has pages.
    if (page + 1 >= CODEX_THREAD_MAX_PAGES) incomplete = true;
  }
  return { headRefOid, reviewThreads: { nodes }, incomplete };
}

// Normalize one GraphQL reviewThread node into { author, oid, resolved }.
// Everything unknown becomes "" / false, which never matches a head.
function normalizeThread(node) {
  const first = node?.comments?.nodes?.[0];
  return {
    author: String(first?.author?.login ?? "").trim().toLowerCase(),
    // The empty string means "unknown" and must never compare equal to a head.
    oid: String(first?.originalCommit?.oid ?? "").trim().toLowerCase(),
    resolved: node?.isResolved === true,
    // Comments after the first one: a reply. Unknown counts as none.
    replies: Math.max(0, (Number.isInteger(node?.comments?.totalCount) ? node.comments.totalCount : 1) - 1),
  };
}

// Every still-open review thread the Codex App started on this PR.
export function codexBotThreads(pullRequest) {
  const nodes = pullRequest?.reviewThreads?.nodes;
  if (!Array.isArray(nodes)) return [];
  return nodes.map(normalizeThread).filter((thread) => isCodexBotLogin(thread.author));
}

// Does a thread's originating commit identify the head being merged?
//
// The empty string means "unknown" on BOTH sides and must never compare equal.
// This is not belt-and-braces: `gh pr view --json latestReviews` returns
// commit.oid "" on every entry, and a GraphQL node whose first comment cannot be
// read normalizes to "" here too. Without the explicit emptiness test an unknown
// oid and an unknown head would match each other, and a thread bound to nothing
// would be treated as bound to this exact commit.
//
// Split out of evaluateCodexBotReview() so it is reachable on its own: inside
// that function an empty head returns early, which made the emptiness test dead
// code that mutation testing could delete without any test going red.
export function oidMatchesHead(oid, head) {
  const left = String(oid || "").trim().toLowerCase();
  const right = String(head || "").trim().toLowerCase();
  return left !== "" && right !== "" && left === right;
}

// The blocking condition, in one place: an unresolved Codex thread raised
// against the exact commit being merged.
export function isStandingAtHead(thread, head) {
  // Handled = resolved AND answered (at least one reply). Since #973 a Codex
  // session may resolve threads, so a silent resolve must not clear a finding
  // (Luna round 7) — the same rule as CodeRabbit's threads.
  const handled = thread?.resolved === true && Number(thread?.replies) >= 1;
  return !handled && oidMatchesHead(thread?.oid, head);
}

// Classify the Codex App's position on the head that is about to merge.
//
// Returns { status, unresolvedAtHead, codexThreads, headOid }, where status is
// "findings-at-head" | "clean-at-head" | "stale" | "none" | "incomplete". Only
// @speed-bump — only one of five statuses blocks, and every uncertain status
// allows; see the fail-open note above.
// "findings-at-head" blocks a merge; see the fail-open note above.
//
// "incomplete" (Codex round 11): the thread walk ended without reaching every
// page (see collectCodexThreads). A standing finding that WAS read still blocks
// — partial evidence of a problem is evidence — but a partial read is never
// reported as clean, stale, or none, because the unread pages could hold the
// unresolved thread. Callers print a notice for it, as for every other
// non-blocking outcome.
export function evaluateCodexBotReview(pullRequest) {
  const head = String(pullRequest?.headRefOid || "").trim().toLowerCase();
  const threads = codexBotThreads(pullRequest);
  const base = { unresolvedAtHead: 0, codexThreads: threads.length, headOid: head };

  // Unresolved AND raised against this exact commit — checked FIRST so a
  // standing finding on a page that was read blocks even when later pages
  // were not.
  const standing = head ? threads.filter((thread) => isStandingAtHead(thread, head)) : [];
  if (standing.length > 0) {
    return { status: "findings-at-head", ...base, unresolvedAtHead: standing.length };
  }
  if (pullRequest?.incomplete === true) return { status: "incomplete", ...base };

  if (threads.length === 0) return { status: "none", ...base };
  // An unknown head cannot be matched against anything. Report rather than
  // guess — "stale" prints, it does not block.
  if (!head) return { status: "stale", ...base };

  // It has threads here, but nothing unresolved is anchored to this head:
  // either everything was worked, or its findings predate the current commit.
  const anyAtHead = threads.some((thread) => oidMatchesHead(thread.oid, head));
  return { status: anyAtHead ? "clean-at-head" : "stale", ...base };
}

// ── CodeRabbit's unanswered findings (Mason, 2026-10-19) ─────────────────────
// CodeRabbit became advisory on 2026-10-19: since 2026-10-21 it reviews a PR
// only when an agent requests it (no automatic reviews), and it never approves
// or requests changes, so nothing it says can
// hold a merge on its own. Its comment threads are the one record of what it
// found. Every UNRESOLVED CodeRabbit thread on the PR blocks — on ANY commit,
// not only the head, because CodeRabbit never re-reviews: a fix pushed after its
// review moves the head past every thread it opened, and a head-only rule would
// let all of them through unanswered. The exit is the same as for the Codex App:
// fix it and resolve the thread, or reply with a one-line reason and resolve it.
// Unlike the Codex App check, this FAILS CLOSED (Luna round 3, HIGH): a thread
// read that fails, or stops before the last page, cannot rule out an unanswered
// finding, so the gates refuse and the agent retries. Use coderabbitThreadCount().
export const CODERABBIT_LOGINS = Object.freeze(["coderabbitai", "coderabbitai[bot]"]);

export function isCodeRabbitLogin(login) {
  return CODERABBIT_LOGINS.includes(String(login || "").trim().toLowerCase());
}

// How many review threads CodeRabbit opened on this PR that are not HANDLED.
// Handled = resolved AND answered: at least one reply after CodeRabbit's comment
// (the fix or the reason it is wrong). Resolving without a word does not count
// (Luna rounds 4–6): the gate cannot judge a reply, but it can require one.
export function unresolvedCodeRabbitThreads(pullRequest) {
  const nodes = pullRequest?.reviewThreads?.nodes;
  if (!Array.isArray(nodes)) return 0;
  return nodes.map(normalizeThread)
    .filter((thread) => isCodeRabbitLogin(thread.author) && !(thread.resolved && thread.replies >= 1)).length;
}

// The count the gates act on, or null when the read cannot be trusted as
// complete. A partial read that already SHOWS an open thread still returns that
// count — partial evidence of a finding is evidence.
export function coderabbitThreadCount(pullRequest) {
  if (!pullRequest || !String(pullRequest.headRefOid || "")) return null;
  // No thread list at all is a malformed answer, not an empty one (Luna round 4).
  if (!Array.isArray(pullRequest?.reviewThreads?.nodes)) return null;
  // A thread whose opening comment's author cannot be read could be CodeRabbit's
  // — unreadable, not clean (Luna round 7).
  if (pullRequest.reviewThreads.nodes.some((node) => !String(node?.comments?.nodes?.[0]?.author?.login ?? "").trim())) {
    return null;
  }
  const open = unresolvedCodeRabbitThreads(pullRequest);
  if (open > 0) return open;
  return pullRequest.incomplete === true ? null : 0;
}

export function coderabbitUnreadableDenial(prefix, selector) {
  const which = selector ? String(selector) : "<number>";
  return (
    `${prefix}: could not read this pull request's review threads completely, so unanswered CodeRabbit ` +
    "findings cannot be ruled out (fail closed, Luna round 3). Retry the merge in a minute; if it keeps " +
    `failing, check them by hand (gh pr view ${which} --comments) and tell Mason the thread lookup is failing.`
  );
}

export function coderabbitFindingsDenial(prefix, selector, count) {
  const which = selector ? String(selector) : "<number>";
  const n = Number(count) > 0 ? Number(count) : 1;
  const noun = n === 1 ? "an unresolved comment thread" : `${n} unresolved comment threads`;
  return (
    `${prefix}: CodeRabbit has ${noun} on this pull request. Its approval is not required (Mason, ` +
    "2026-10-19), but its findings are: every one must be fixed or answered before the merge.\n\n" +
    `  1. Read them:  gh pr view ${which} --comments      (author: coderabbitai)\n` +
    "  2. Fix each real issue and push (CodeRabbit will not re-review; the checks and Sol cover the fix).\n" +
    "  3. REPLY on each thread (what you fixed, or a one-line reason it is wrong), then resolve it —\n" +
    "     a thread resolved with no reply still counts as unanswered."
  );
}

// ── Money PRs need a completed CodeRabbit review of the head (Mason, 2026-10-21) ──
// A PR that touches money, invoices, payments, inventory or costs, or one Mason
// names, merges only with a clean CodeRabbit review of its current head
// (docs/reference/coderabbit-native-review.md). "Clean" is the thread rule above;
// THIS check adds "a review exists at all", because with no review there are no
// threads to block (Sol, PR #1009). Both merge gates and the migration landing
// gate call it, and it FAILS CLOSED like the thread count: an unreadable answer
// refuses.
//
// WHY A COMMIT STATUS, NOT A REVIEW OBJECT  (measured 2026-10-21, PRs #970–#1002)
// CodeRabbit files an empty COMMENTED review object every time it answers a
// thread reply, at whatever commit is the head then (#1002: ddc030a24, #995:
// 54ed8a737), so "a CodeRabbit review exists on the head" would be satisfied by
// a chat reply. Its commit status is exact: context "CodeRabbit", set by
// coderabbitai, description "Review completed" only on a commit it reviewed, and
// "Review rate limited" / "Review skipped: …" otherwise. The creator is checked
// because anyone with write access can post a status with any context name —
// including an agent through Mason's account.
//
// AND A CHECK RUN  (measured 2026-10-27 on #1134, 4a8914672 / 52b05497b)
// From about 01:45 UTC on 2026-10-27 CodeRabbit reports a finished review as a
// check run named "CodeRabbit" (conclusion SUCCESS, summary "Result: Success -
// Review completed") and may set no commit status at all; a skip is conclusion
// SKIPPED, "Result: Skipped - Review skipped". Only the CodeRabbit GitHub App can
// create a check run in its own suite, so the app's id is the identity check.
// Either signal counts.
export const CODERABBIT_APP_ID = 347564;
export const CODERABBIT_REQUIRED_LABEL = "needs-coderabbit";

// Lower-case substrings of a src/ path that mark it as money, invoice, payment,
// inventory or cost code. Deliberately broad ("when unsure, it qualifies"):
// a false positive costs one CodeRabbit request, a miss lands money code with
// no second reviewer. Anything this list misses is what the label is for.
// ACCEPTED GAP (Mason, 2026-10-21, "money only, accept the gap", choosing this
// over gating every src/ change): money logic in a generically named file is
// not caught here; the agent's duty to add the label is the only cover for it.
export const MONEY_PATH_WORDS = Object.freeze([
  "invoice", "payment", "prepay", "credit", "money", "cents", "price", "pricing", "cost", "margin",
  "inventory", "stock", "commission", "bill", "purchase", "bulkpo", "refund", "return", "deposit",
  "ledger", "tax", "aging", "statement", "quote", "order", "delivery", "blend", "split", "cash",
  "charge", "discount", "payable", "receivable", "receipt", "financ", "profit", "sales", "booking",
  "cyclecount", "lotrpc", "idempot",
  // src/lib/chemCalculator.ts turns quantities and per-unit prices into billed
  // amounts (Sol, PR #1009).
  "calculator",
]);

// Every database migration and Edge Function qualifies: financial and inventory
// invariants live in PostgreSQL (AGENTS.md), so a path list cannot tell a money
// migration from any other.
export function isMoneyPath(path) {
  const p = String(path || "").replace(/\\/g, "/").trim().toLowerCase();
  if (/^supabase\/(?:migrations|functions)\//.test(p)) return true;
  if (!p.startsWith("src/")) return false;
  return MONEY_PATH_WORDS.some((word) => p.includes(word));
}

// One GraphQL read: labels, changed files, and the PR's commits with their
// parent counts, latest commit statuses and CodeRabbit's own check runs (newest
// commit last).
export const CODERABBIT_REQUIREMENT_QUERY = `
query($owner:String!, $name:String!, $number:Int!) {
  repository(owner:$owner, name:$name) {
    pullRequest(number:$number) {
      number
      baseRepository { nameWithOwner }
      headRefOid
      baseRefOid
      labels(first:100) { totalCount nodes { name } }
      files(first:100) { totalCount nodes { path } }
      commits(last:100) {
        totalCount
        nodes { commit { oid parents(first:2) { totalCount nodes { oid } } status { contexts { context state description creator { login } } }
          checkSuites(first:5, filterBy:{appId:${CODERABBIT_APP_ID}}) { totalCount nodes { app { databaseId slug } checkRuns(first:10, filterBy:{checkName:"CodeRabbit"}) { totalCount nodes { name status conclusion summary } } } } } }
      }
    }
  }
}`;

// The gh arguments for that read, so the three callers cannot drift.
export function coderabbitRequirementArgs(owner, name, number) {
  return [
    "api", "graphql",
    "-f", `query=${CODERABBIT_REQUIREMENT_QUERY}`,
    "-F", `owner=${owner}`,
    "-F", `name=${name}`,
    "-F", `number=${number}`,
  ];
}

// The pull-request link CodeRabbit puts in its check-run summary, e.g.
// "(https://app.coderabbit.ai/change-stack/<owner>/<repo>/pull/1134?scope=…)".
// A check run belongs to a commit, not a PR, so two PRs sharing a head would
// share it; this link names the PR it reviewed (Sol on #1125).
const CODERABBIT_PR_LINK = /\(https:\/\/app\.coderabbit\.ai\/change-stack\/([^/\s)]+)\/([^/\s)]+)\/pull\/(\d+)(?=\/?[?#)])/gi;
export function coderabbitRunReviewedPr(summary, pullRequest) {
  const number = pullRequest?.number;
  const repo = String(pullRequest?.baseRepository?.nameWithOwner || "").trim().toLowerCase();
  if (!Number.isInteger(number) || number <= 0 || !/^[^/\s]+\/[^/\s]+$/.test(repo)) return false;
  const links = String(summary || "").matchAll(CODERABBIT_PR_LINK);
  return [...links].some((m) => `${m[1]}/${m[2]}`.toLowerCase() === repo && Number(m[3]) === number);
}

// A completed CodeRabbit review run whose PR link cannot be read: it may be this
// PR's review, so it can never prove "CodeRabbit never reviewed" (Luna on #1125).
function coderabbitUnboundCompletedRun(commit) {
  const suites = commit?.checkSuites?.nodes;
  if (!Array.isArray(suites)) return false;
  return suites.some((suite) => suite?.app?.databaseId === CODERABBIT_APP_ID && Array.isArray(suite?.checkRuns?.nodes)
    && suite.checkRuns.nodes.some((run) =>
      String(run?.conclusion || "").trim().toUpperCase() === "SUCCESS"
      && /^Result: Success - Review completed\b/.test(String(run?.summary || "").trim())
      && ![...String(run?.summary || "").matchAll(CODERABBIT_PR_LINK)].length));
}

// Did CodeRabbit itself mark this commit "Review completed", by commit status
// or by a check run in its own app's suite that names this pull request?
export function coderabbitCompletedCommit(commit, pullRequest = null) {
  const contexts = commit?.status?.contexts;
  const byStatus = Array.isArray(contexts) && contexts.some((context) =>
    String(context?.context || "").trim().toLowerCase() === "coderabbit"
    && isCodeRabbitLogin(context?.creator?.login)
    && String(context?.state || "").trim().toUpperCase() === "SUCCESS"
    && /^review completed\b/i.test(String(context?.description || "").trim()));
  if (byStatus) return true;
  const suites = commit?.checkSuites?.nodes;
  if (!Array.isArray(suites)) return false;
  return suites.some((suite) =>
    suite?.app?.databaseId === CODERABBIT_APP_ID
    && String(suite?.app?.slug || "").trim().toLowerCase() === "coderabbitai"
    && Array.isArray(suite?.checkRuns?.nodes)
    && suite.checkRuns.nodes.some((run) =>
      String(run?.name || "").trim() === "CodeRabbit"
      && String(run?.status || "").trim().toUpperCase() === "COMPLETED"
      && String(run?.conclusion || "").trim().toUpperCase() === "SUCCESS"
      && /^Result: Success - Review completed\b/.test(String(run?.summary || "").trim())
      && coderabbitRunReviewedPr(run?.summary, pullRequest)));
}

// Were all of CodeRabbit's check suites and runs on this commit read? The query
// takes the first 5 and 10, so a longer list could hide a review: such a commit
// can never prove "CodeRabbit never reviewed" (Luna, #1125). A missing or
// malformed field is not proof either.
function coderabbitRunsComplete(commit) {
  const suites = commit?.checkSuites;
  const fits = (list) => Array.isArray(list?.nodes) && Number.isInteger(list?.totalCount) && list.totalCount >= 0 && list.totalCount <= list.nodes.length;
  return fits(suites) && suites.nodes.every((suite) => fits(suite?.checkRuns));
}

// Returns { status, why, headOid, reviewedOid } where status is
// "not-required" | "reviewed" | "missing" | "unreadable".
//
// "reviewed" = CodeRabbit completed a review of the head, or of an earlier PR
// commit followed ONLY by merge commits (a plain merge of main keeps an earlier
// clean review, Mason 2026-10-21). This function only sees parent COUNTS, so a
// merge-walk "reviewed" is provisional: readCodeRabbitRequirement() then proves
// the PR's own changes are byte-identical at the reviewed commit and the head
// (Luna round 5, BLOCKER: a merge commit can carry new code).
export function evaluateCodeRabbitRequirement(pullRequest) {
  const headOid = String(pullRequest?.headRefOid || "").trim().toLowerCase();
  const unreadable = (why = "") => ({ status: "unreadable", why, headOid, reviewedOid: "" });
  if (!headOid) return unreadable();
  const labels = pullRequest?.labels?.nodes;
  const files = pullRequest?.files?.nodes;
  const commits = pullRequest?.commits?.nodes;
  if (!Array.isArray(labels) || !Array.isArray(files) || !Array.isArray(commits)) return unreadable();
  // A file or label entry with no readable name could be the money file or the
  // label: a partial answer is unreadable, never "not required" (Sol, PR #1009).
  if (files.some((file) => typeof file?.path !== "string" || !file.path.trim())
    || labels.some((label) => typeof label?.name !== "string" || !label.name.trim())) {
    return unreadable();
  }

  // A label list cut short cannot prove the label is absent (Luna round 5).
  const labelTotal = pullRequest?.labels?.totalCount;
  const labelled = labels.some((label) => String(label?.name || "").trim().toLowerCase() === CODERABBIT_REQUIRED_LABEL)
    || !(Number.isInteger(labelTotal) && labelTotal <= labels.length);
  const moneyFile = files.map((file) => file?.path).find(isMoneyPath);
  // A file list that may be cut short cannot prove the PR is not a money PR.
  const total = pullRequest?.files?.totalCount;
  const filesComplete = Number.isInteger(total) && total <= files.length;
  let why = "";
  if (labelled) why = `it carries the "${CODERABBIT_REQUIRED_LABEL}" label (or its labels could not all be read)`;
  else if (moneyFile) why = `it changes money, invoice, payment, inventory or cost files (e.g. ${moneyFile})`;
  else if (!filesComplete) why = "its changed-file list could not be read completely";
  else return { status: "not-required", why: "", headOid, reviewedOid: "" };

  const list = commits.map((node) => node?.commit);
  if (list.length === 0 || String(list[list.length - 1]?.oid || "").trim().toLowerCase() !== headOid) {
    return unreadable(why);
  }
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const commit = list[i];
    if (coderabbitCompletedCommit(commit, pullRequest)) {
      return { status: "reviewed", why, headOid, reviewedOid: String(commit.oid).trim().toLowerCase() };
    }
    const parents = commit?.parents?.totalCount;
    // Only a merge commit may sit between the reviewed commit and the head.
    if (!(Number.isInteger(parents) && parents >= 2)) break;
  }
  // Whether CodeRabbit ever completed a review on this PR: before the first one,
  // a Sol review may run first (Mason, 2026-10-26); after it, a later commit may
  // still be covered by a minor-only review (readMinorFollowUp). The query reads
  // only the last 100 commits, so "never reviewed" needs the whole list; a cut-short
  // list without a review is unknown, which never lets Sol go first (Codex App P2 on #1125).
  const commitTotal = pullRequest?.commits?.totalCount;
  let priorReview;
  if (list.some((commit) => coderabbitCompletedCommit(commit, pullRequest))) priorReview = true;
  else if (Number.isInteger(commitTotal) && commitTotal >= 0 && commitTotal <= list.length && list.every(coderabbitRunsComplete)
    && !list.some(coderabbitUnboundCompletedRun)) priorReview = false;
  return { status: "missing", why, headOid, reviewedOid: "", priorReview };
}

// The PR's own changes relative to main, as {filename: "status:blobsha"}. The
// compare API's three-dot form diffs from the merge base, so merging main in
// does not change it unless the merge itself edits a PR file.
export const COMPARE_FILE_CAP = 300; // GitHub's compare API returns at most 300 files
export function coderabbitCompareArgs(owner, name, base, sha) {
  return ["api", `repos/${owner}/${name}/compare/${base}...${sha}`,
    "--jq", "[.files[] | {filename, status, sha, previous_filename}]"];
}
// Every changed file, one per line as "path<TAB>previous path" (empty unless
// renamed), over REST (up to GitHub's 3000-file limit for this endpoint). GraphQL
// does not report a rename's source, and a money file renamed to a generic name
// is still a money change (Sol, PR #1009).
export function coderabbitFileListArgs(owner, name, number) {
  return ["api", `repos/${owner}/${name}/pulls/${number}/files?per_page=100`, "--paginate",
    "--jq", ".[] | [.filename, (.previous_filename // \"\")] | @tsv"];
}

export function prOwnChangesUnchanged(atReview, atHead) {
  const index = (files) => {
    if (!Array.isArray(files) || files.length >= COMPARE_FILE_CAP) return null;
    const map = new Map();
    for (const file of files) {
      const filename = String(file?.filename || "");
      if (!filename) return null;
      // A rename's source is part of its identity (Codex App P2 on #1009): the
      // same destination and blob renamed from a different path is a different change.
      map.set(filename, `${String(file?.status || "")}:${String(file?.sha || "")}:${String(file?.previous_filename || "")}`);
    }
    return map;
  };
  const before = index(atReview);
  const after = index(atHead);
  if (!before || !after || before.size !== after.size) return false;
  for (const [filename, value] of before) if (after.get(filename) !== value) return false;
  return true;
}

// The whole requirement read, shared by all three gates. `runGh(args)` returns
// gh's stdout. Throws on an exhausted budget or a failed call; the callers turn a
// throw into a fail-closed refusal. `callTimeoutMs` is the longest one gh call
// may take: a call is not STARTED unless it can finish before `deadlineMs`, because
// a hook killed mid-call emits nothing, and a hook that emits nothing allows
// (Luna round 5, HIGH).
export function readCodeRabbitRequirement(runGh, { owner, name, number, deadlineMs = null, callTimeoutMs = 0, now = Date.now }) {
  const call = (args) => {
    if (deadlineMs !== null && now() + callTimeoutMs >= deadlineMs) {
      throw new Error("CodeRabbit requirement lookup would exceed the hook's time budget");
    }
    return runGh(args);
  };
  const answer = JSON.parse(call(coderabbitRequirementArgs(owner, name, number)));
  // GraphQL can return partial data alongside errors; never decide on that (Sol, PR #1009).
  if (Array.isArray(answer?.errors) && answer.errors.length > 0) {
    throw new Error("GitHub returned errors with the CodeRabbit requirement read");
  }
  const pullRequest = answer?.data?.repository?.pullRequest;
  // Always read the file list over REST as well: it is complete past GraphQL's
  // 100 (Luna round 6) and it names each rename's SOURCE, so a money file renamed
  // to a generic path still qualifies (Sol, PR #1009). Both paths of a rename are
  // classified. If the REST count does not match GitHub's total, the GraphQL list
  // stays and an incomplete one makes the PR qualify (fail closed).
  const fileTotal = pullRequest?.files?.totalCount;
  if (Number.isInteger(fileTotal) && Array.isArray(pullRequest?.files?.nodes)) {
    const rows = String(call(coderabbitFileListArgs(owner, name, number))).split(/\r?\n/).filter((line) => line.trim());
    if (rows.length === fileTotal) {
      const paths = [];
      for (const row of rows) {
        const [current, previous] = row.split("\t");
        paths.push(String(current || "").trim());
        if (String(previous || "").trim()) paths.push(String(previous).trim());
      }
      pullRequest.files.nodes = paths.map((path) => ({ path }));
    } else {
      // A REST list that disagrees with the total cannot prove anything.
      pullRequest.files.nodes = [];
      pullRequest.files.totalCount = Math.max(fileTotal, 1);
    }
  }
  const verdict = evaluateCodeRabbitRequirement(pullRequest);
  if (verdict.status === "missing" && verdict.priorReview) {
    return readMinorFollowUp(call, { owner, name, number, pullRequest, verdict });
  }
  if (verdict.status !== "reviewed" || verdict.reviewedOid === verdict.headOid) return verdict;
  const base = String(pullRequest?.baseRefOid || "").trim();
  if (!/^[0-9a-f]{40}$/i.test(base)) return { ...verdict, status: "unreadable" };
  const atReview = JSON.parse(call(coderabbitCompareArgs(owner, name, base, verdict.reviewedOid)));
  const atHead = JSON.parse(call(coderabbitCompareArgs(owner, name, base, verdict.headOid)));
  if (prOwnChangesUnchanged(atReview, atHead)) return verdict;
  return {
    ...verdict,
    status: "missing",
    reviewedOid: "",
    // CodeRabbit did review this PR; only the merge voided it (Codex App P2 on #1125).
    priorReview: true,
    why: `${verdict.why}; the PR's own changes differ between the reviewed commit and the head, so a merge since the review changed them`,
  };
}

// ── ONE CODERABBIT REVIEW PER PR: MINOR FOLLOW-UPS (Mason, 2026-10-26) ────────
// CodeRabbit's included allowance is per developer identity and adaptive: 80+
// reviews in 7 days drops it to one an hour, and every agent posts as Mason.
// Measured 2026-10-26: 120 reviews in 7 days, 93% of them on PRs reviewed more
// than once, because any fix after a review needed a brand-new full review. Mason:
// "no need to re review coderabbit again if only minor issue found". The plan went
// through three adversarial Sol rounds (docs/reference/coderabbit-native-review.md).
//
// So a later head still counts as reviewed when every one of these holds; any
// failure means one new `@coderabbitai full review`, as before:
//   - the PR's commits from the head are: merges that leave the PR's own changes
//     as they were at the last fix (so they brought in only the base), then a
//     linear chain of fix commits, then R, the newest commit CodeRabbit
//     marked "Review completed" (proved by parent SHAs, and the compare must list
//     exactly that chain);
//   - CodeRabbit's review of R posted K >= 1 inline findings, exactly K were read,
//     and every one is labelled Minor or Trivial by CodeRabbit itself;
//   - its review summary lists no outside-diff, duplicate or nitpick items and no
//     warning box, and its pre-merge checks for R all passed (PR title and
//     description checks excepted);
//   - the fixes (R..F) touch only files holding a finding, tests, and one new
//     changelog entry; nothing under supabase/, CI, agent tooling, scripts,
//     dependencies or configuration; no rename, delete, binary or mode change;
//     at most 60 changed lines in finding files and 150 in tests (20 deleted).
// The final exact-SHA Sol review still runs, and is shown those fixes
// (scripts/write-codex-push-proof.mjs). As with every gate here, an agent with
// Mason's authority could bypass this deliberately; it guards against mistakes.
//
// Three outcomes: covered ("reviewed"), not covered ("missing", with the failed
// condition in `why`: request one new review), or "unreadable" (a read failed or
// was cut short: retry, never spend a new review on it).
export const FOLLOWUP_MAX_FINDING_LINES = 60;
export const FOLLOWUP_MAX_TEST_LINES = 150;
export const FOLLOWUP_MAX_TEST_DELETIONS = 20;
export const FOLLOWUP_MAX_CHANGELOG_LINES = 40;
export const FOLLOWUP_MAX_CHAIN = 30;
export const FOLLOWUP_MAX_FILES = 20;
// Pre-merge checks about the PR's title and text, not its code, may fail.
export const FOLLOWUP_METADATA_CHECKS = Object.freeze(["title check", "description check"]);
// The custom checks in .coderabbit.yaml, as CodeRabbit names them in its table.
// The test pins this list to that file.
export const FOLLOWUP_REQUIRED_CHECKS = Object.freeze([
  "new table without rls",
  "security definer without search_path",
  "mutating rpc without idempotency key",
  "money not exact whole cents",
  "edit to an already-applied migration",
]);
const FOLLOWUP_EXCLUDED_PATHS = [
  /^supabase\//, /^\.github\//, /^\.claude\//, /^\.codex\//, /^\.agents\//, /^\.husky\//, /^scripts\//,
  /^eslint-local-rules\//, /^\.coderabbit\.ya?ml$/, /(?:^|\/)(?:agents|claude)\.md$/, /(?:^|\/)\.cursorrules$/,
  /(?:^|\/)(?:package(?:-lock)?\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|deno\.lock|vercel\.json)$/,
  /(?:^|\/)tsconfig[^/]*\.json$/, /(?:^|\/)[^/]*\.config\.[^/]+$/, /(?:^|\/)\.git[^/]*$/, /(?:^|\/)\.env/,
  // Configuration by name anywhere: src/config.ts, config/payment-limits.json (Luna round 3).
  /(?:^|\/)config(?:\/|\.[^/]+$)/, /(?:^|\/)[^/]*\.(?:ya?ml|toml|ini)$/,
  // Every dotfile or dot-folder is tooling or runtime configuration (.nvmrc picks CI's
  // Node, .npmrc the registry), as are the extensionless build files (Codex App P2 on #1125).
  /(?:^|\/)\./, /(?:^|\/)(?:dockerfile|makefile|procfile|justfile)(?:\.[^/]*)?$/,
];
const lowerPath = (path) => String(path || "").replace(/\\/g, "/").trim().toLowerCase();
export function isFollowUpExcludedPath(path) {
  const p = lowerPath(path);
  return !p || FOLLOWUP_EXCLUDED_PATHS.some((re) => re.test(p));
}
// scripts/smoke/ holds the rolled-back business-chain tests (ship.md Step 5.4),
// which fixes often extend. Only the chains themselves (smoke-*.sql, prove-*.mjs)
// count; the runner and verdict code (run-smoke.mjs, interpret-result.mjs, seeds,
// setup) and the rest of scripts/ stay excluded (Codex App P2 on #1125).
export function isFollowUpTestPath(path) {
  const p = lowerPath(path);
  return /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(p) || /^tests\//.test(p) || /\/__tests__\//.test(p)
    || /^scripts\/smoke\/smoke-[^/]+\.sql$/.test(p) || /^scripts\/smoke\/prove-[^/]+\.mjs$/.test(p);
}
// The shared status ledgers almost every PR edits. A merge of main may change one
// even when the PR edits it too; policy and reference documents get no such
// exception (Luna round 2 on #1125).
export const FOLLOWUP_SHARED_LEDGERS = Object.freeze([
  "docs/manual/known_issues.md",
  "docs/manual/to_do_list.md",
  "docs/manual/current_state.md",
  "docs/reference/migration-history.md",
  "docs/changelog.md",
]);
export function isFollowUpPlainDocPath(path) {
  return FOLLOWUP_SHARED_LEDGERS.includes(lowerPath(path));
}
export function isFollowUpChangelogPath(path) {
  return /^docs\/changelog\.d\/[^/]+\.md$/.test(lowerPath(path));
}

// CodeRabbit's own severity label, read ONLY from a finding's header line (the
// first line that is not an HTML comment), never from quoted code or its AI
// prompt. Two header formats are in use (both seen 2026-10):
//   **<picture>…review-comment-icons-v1/amber-16.svg…</picture> Minor** · **Category** · …
//   **🎯 Category** | **🟡 Minor** | **⚡ Quick win**
// Returns "critical" | "major" | "minor" | "trivial", or null when unrecognised.
// Minor and trivial must also carry their own icon or colour.
const SEVERITY_ICON = { minor: "amber", trivial: "neutral" };
const SEVERITY_EMOJI = { critical: "🔴", major: "🟠", minor: "🟡", trivial: "🔵" };
export function coderabbitFindingSeverity(body) {
  const first = String(body || "").split(/\r?\n/).find((line) => line.trim() && !/^\s*<!--[\s\S]*-->\s*$/.test(line));
  const line = String(first || "").trim();
  const pictured = line.match(/^\*\*<picture>((?:(?!<\/picture>).)*)<\/picture>\s*(Critical|Major|Minor|Trivial)\*\*(?:\s·\s|$)/);
  if (pictured) {
    const word = pictured[2].toLowerCase();
    if (!SEVERITY_ICON[word]) return word;
    const icon = (pictured[1].match(/review-comment-icons-v1\/([a-z]+)-16\.svg/) || [])[1];
    return icon === SEVERITY_ICON[word] ? word : null;
  }
  const cells = line.split(" | ").map((cell) => cell.trim().match(/^\*\*(\S+) (Critical|Major|Minor|Trivial)\*\*$/u)).filter(Boolean);
  if (cells.length !== 1) return null;
  const word = cells[0][2].toLowerCase();
  return cells[0][1] === SEVERITY_EMOJI[word] ? word : null;
}

// "**Actionable comments posted: K**" from a full review's body, or null.
// Exactly one count line, or null (Luna round 1 on #1125).
export function coderabbitReviewFindingCount(body) {
  const matches = [...String(body || "").matchAll(/^\*\*Actionable comments posted: (\d+)\*\*\s*$/gm)];
  return matches.length === 1 ? Number(matches[0][1]) : null;
}

// Items in the review summary that have no thread and no reliable per-item
// severity. Any of them means no minor follow-up.
export function coderabbitReviewBodyProblem(body) {
  const text = String(body || "");
  if (/Outside diff range comments/i.test(text)) return "its review lists comments outside the changed lines";
  if (/Duplicate comments/i.test(text)) return "its review repeats earlier comments";
  if (/Nitpick comments/i.test(text)) return "its review lists nitpick comments in its summary";
  if (/\[!(?:CAUTION|WARNING|IMPORTANT)\]/i.test(text)) return "its review summary carries a warning box";
  return null;
}

// The pre-merge checks in CodeRabbit's walkthrough comment, bound to the reviewed
// commit by its change_assessment_commit marker. Returns { kind, why }.
export function coderabbitPreMergeChecks(walkthroughBody, reviewedOid) {
  const body = String(walkthroughBody || "");
  const unreadable = (why) => ({ kind: "unreadable", why });
  const assessed = (body.match(/<!--\s*change_assessment_commit:"([0-9a-f]{40})"\s*-->/i) || [])[1];
  if (!assessed) return unreadable("CodeRabbit's summary comment does not say which commit it describes");
  if (assessed.toLowerCase() !== reviewedOid) {
    return unreadable(`CodeRabbit's summary comment describes ${assessed.slice(0, 9)}, not the reviewed commit ${reviewedOid.slice(0, 9)}`);
  }
  const start = body.indexOf("<!-- pre_merge_checks_walkthrough_start -->");
  const end = body.indexOf("<!-- pre_merge_checks_walkthrough_end -->");
  if (start < 0 || end < start) return unreadable("CodeRabbit's summary comment has no complete pre-merge check table");
  const section = body.slice(start, end);
  const summary = (section.match(/<summary>[^\n]*Pre-merge checks:[^\n]*<\/summary>/) || [])[0];
  if (!summary) return unreadable("CodeRabbit's pre-merge check summary could not be read");
  const expected = [...summary.matchAll(/alt="[A-Za-z]+"[^>]*><\/picture><\/sup>\s*(\d+)/g)].reduce((sum, m) => sum + Number(m[1]), 0);
  const rows = [];
  for (const line of section.split(/\r?\n/)) {
    if (!line.trim().startsWith("|")) continue;
    const cells = line.split("|").map((cell) => cell.trim());
    if (/^:?-+:?$/.test(cells[1] || "") || /^check name$/i.test(cells[1] || "")) continue;
    const status = ((cells[2] || "").match(/^!\[([A-Za-z]+)\]\(/) || [])[1];
    if (!cells[1] || !status) return unreadable("a CodeRabbit pre-merge check row could not be read");
    rows.push({ name: cells[1].replace(/\s+/g, " ").toLowerCase(), status: status.toLowerCase() });
  }
  if (expected === 0 || rows.length !== expected) {
    return unreadable(`CodeRabbit's pre-merge table lists ${rows.length} checks but its summary counts ${expected}`);
  }
  for (const row of rows) {
    if (row.status !== "passed" && !FOLLOWUP_METADATA_CHECKS.includes(row.name)) {
      return { kind: "not-covered", why: `CodeRabbit's "${row.name}" pre-merge check reads ${row.status}` };
    }
  }
  for (const name of FOLLOWUP_REQUIRED_CHECKS) {
    if (!rows.some((row) => row.name === name && row.status === "passed")) {
      return { kind: "not-covered", why: `CodeRabbit's "${name}" pre-merge check did not pass` };
    }
  }
  return { kind: "ok", why: "" };
}

// Walk the PR's commits by parent SHA: merges of main at the tip, then the fix
// chain, ending at R. Returns { kind, why, reviewedOid, fixOid, chain, tipMerges }.
export function followUpChain(pullRequest) {
  const head = String(pullRequest?.headRefOid || "").trim().toLowerCase();
  const nodes = (pullRequest?.commits?.nodes || []).map((node) => node?.commit).filter(Boolean);
  const byOid = new Map(nodes.map((commit) => [String(commit.oid || "").toLowerCase(), commit]));
  const parentsOf = (commit) => {
    const count = commit?.parents?.totalCount;
    const oids = (commit?.parents?.nodes || []).map((parent) => String(parent?.oid || "").toLowerCase());
    if (!Number.isInteger(count) || oids.length !== Math.min(count, 2) || oids.some((oid) => !/^[0-9a-f]{40}$/.test(oid))) return null;
    return { count, oids };
  };
  const unreadable = (why) => ({ kind: "unreadable", why });
  const notCovered = (why) => ({ kind: "not-covered", why });
  let current = byOid.get(head);
  const tipMerges = [];
  for (;;) {
    if (!current) return notCovered("the head's history leaves the PR's own commits before reaching the fixes");
    const parents = parentsOf(current);
    if (!parents) return unreadable("a commit's parents could not be read");
    if (parents.count < 2) break;
    tipMerges.push(String(current.oid).toLowerCase());
    if (tipMerges.length > FOLLOWUP_MAX_CHAIN) return notCovered("too many merge commits at the tip");
    current = byOid.get(parents.oids[0]);
  }
  const fixOid = String(current.oid).toLowerCase();
  const chain = [];
  for (;;) {
    if (coderabbitCompletedCommit(current, pullRequest)) break;
    const parents = parentsOf(current);
    if (!parents) return unreadable("a commit's parents could not be read");
    if (parents.count !== 1) {
      return notCovered("a merge commit sits between CodeRabbit's review and the fixes (push the fixes first, then merge main)");
    }
    chain.unshift(String(current.oid).toLowerCase());
    if (chain.length > FOLLOWUP_MAX_CHAIN) return notCovered(`more than ${FOLLOWUP_MAX_CHAIN} commits follow CodeRabbit's review`);
    current = byOid.get(parents.oids[0]);
    if (!current) return notCovered("no completed CodeRabbit review sits directly before the fix commits");
  }
  if (chain.length === 0) return notCovered("there are no fix commits after CodeRabbit's review");
  return { kind: "ok", why: "", reviewedOid: String(current.oid).toLowerCase(), fixOid, chain, tipMerges };
}

// The fixes R..F from GitHub's compare. Returns { kind, why, files }. With
// `structuralOnly`, it checks the comparison and each file's kind but not which
// finding a file belongs to or the size limits (used before the review is read).
export function evaluateFollowUpDiff(compare, { chain, findingPaths = [], structuralOnly = false }) {
  const notCovered = (why) => ({ kind: "not-covered", why, files: [] });
  if (!compare || typeof compare !== "object" || !Array.isArray(compare.files) || !Array.isArray(compare.commits)) {
    return { kind: "unreadable", why: "GitHub's comparison of the reviewed commit and the fixes could not be read", files: [] };
  }
  const listed = compare.commits.map((commit) => String(commit?.sha || "").toLowerCase());
  if (compare.status !== "ahead" || compare.behind_by !== 0 || compare.ahead_by !== chain.length
    || compare.total_commits !== chain.length || listed.length !== chain.length || listed.some((sha) => !chain.includes(sha))) {
    return notCovered("GitHub's comparison does not show exactly the fix commits on top of the reviewed commit");
  }
  if (compare.files.length >= COMPARE_FILE_CAP || compare.files.length > FOLLOWUP_MAX_FILES) {
    return notCovered(`the fixes change more than ${FOLLOWUP_MAX_FILES} files`);
  }
  const findings = new Set([...findingPaths].map(lowerPath));
  let findingLines = 0;
  let testLines = 0;
  let testDeletions = 0;
  let changelogs = 0;
  const files = [];
  for (const file of compare.files) {
    const filename = String(file?.filename || "");
    const status = String(file?.status || "");
    const additions = file?.additions;
    const deletions = file?.deletions;
    if (!filename || !Number.isInteger(additions) || !Number.isInteger(deletions)) {
      return { kind: "unreadable", why: "a changed file in the fixes could not be read", files: [] };
    }
    // Hard-excluded paths stay excluded even for test files there (agent tooling,
    // CI); scripts/smoke/ chains are the one exception (Luna round 1 on #1125), and
    // only the chains themselves, not the runner or verdict code (Codex App P2).
    if (isFollowUpExcludedPath(filename) && !(/^scripts\/smoke\//.test(lowerPath(filename)) && isFollowUpTestPath(filename))) {
      return notCovered(`the fixes change ${filename}, which always gets a fresh review`);
    }
    if (file?.previous_filename || !["modified", "added"].includes(status)) {
      return notCovered(`the fixes ${status || "change"} ${filename} (only edits, new tests and one new changelog entry are allowed)`);
    }
    if (typeof file?.patch !== "string" || !file.patch) {
      return notCovered(`${filename} has no text diff (binary, mode-only or too large)`);
    }
    if (structuralOnly) {
      files.push({ filename, status, additions, deletions, category: "", patch: file.patch });
      continue;
    }
    let category;
    if (status === "modified" && findings.has(lowerPath(filename))) {
      category = "finding";
      findingLines += additions + deletions;
    } else if (isFollowUpTestPath(filename)) {
      category = "test";
      testLines += additions + deletions;
      testDeletions += deletions;
    } else if (status === "added" && isFollowUpChangelogPath(filename) && deletions === 0) {
      category = "changelog";
      changelogs += 1;
      if (additions > FOLLOWUP_MAX_CHANGELOG_LINES) return notCovered(`the changelog entry is over ${FOLLOWUP_MAX_CHANGELOG_LINES} lines`);
    } else {
      return notCovered(`the fixes change ${filename}, which holds none of CodeRabbit's findings`);
    }
    files.push({ filename, status, additions, deletions, category, patch: file.patch });
  }
  if (structuralOnly) return { kind: "ok", why: "", files };
  if (changelogs > 1) return notCovered("the fixes add more than one changelog entry");
  if (findingLines > FOLLOWUP_MAX_FINDING_LINES) return notCovered(`the fixes change ${findingLines} lines in finding files (limit ${FOLLOWUP_MAX_FINDING_LINES})`);
  if (testLines > FOLLOWUP_MAX_TEST_LINES) return notCovered(`the fixes change ${testLines} test lines (limit ${FOLLOWUP_MAX_TEST_LINES})`);
  if (testDeletions > FOLLOWUP_MAX_TEST_DELETIONS) return notCovered(`the fixes delete ${testDeletions} test lines (limit ${FOLLOWUP_MAX_TEST_DELETIONS})`);
  if (!files.some((file) => file.category === "finding")) return notCovered("the fixes change no file that holds a finding");
  return { kind: "ok", why: "", files };
}

// Merges after the fixes may not change the PR's own changes: GitHub's three-dot
// compare against the base (every file's status, blob and rename source) must be
// the same at the last fix and at the head, the proof the merge walk above uses.
// That holds only when the merges brought in nothing but the base, so a merge of
// any other branch is refused too (Luna round 1 on #1125). The one exception is a
// plain docs/**/*.md ledger both sides edit (shared KNOWN_ISSUES.md and the like).
export function evaluateTipMerges(atFix, atHead) {
  const index = (files) => {
    if (!Array.isArray(files) || files.length >= COMPARE_FILE_CAP) return null;
    const map = new Map();
    for (const file of files) {
      const filename = String(file?.filename || "");
      const status = String(file?.status || "");
      const sha = String(file?.sha || "");
      // Every entry must carry its status and blob, or equal maps prove nothing (Luna round 2 on #1125).
      if (!filename || !status || !/^[0-9a-f]{40}$/i.test(sha)) return null;
      map.set(filename, `${status}:${sha}:${String(file?.previous_filename || "")}`);
    }
    return map;
  };
  const before = index(atFix);
  const after = index(atHead);
  if (!before || !after) {
    return { kind: "not-covered", why: "the PR's own changes at the last fix and at the head could not be compared in full" };
  }
  for (const filename of new Set([...before.keys(), ...after.keys()])) {
    if (before.get(filename) === after.get(filename)) continue;
    const sharedDoc = isFollowUpPlainDocPath(filename)
      && String(before.get(filename) || "").startsWith("modified:") && String(after.get(filename) || "").startsWith("modified:")
      && before.get(filename).endsWith(":") && after.get(filename).endsWith(":");
    if (sharedDoc) continue;
    return { kind: "not-covered", why: `a merge after the fixes changed the PR's own changes (${filename})` };
  }
  return { kind: "ok", why: "" };
}

// One GraphQL read: CodeRabbit's reviews with their inline comments, the PR's
// issue comments (for the walkthrough), and the tree entry of each fixed file at
// R, F and the head (type and mode).
const FOLLOWUP_QUERY_HEAD = `query($owner:String!, $name:String!, $number:Int!) {
  repository(owner:$owner, name:$name) {
    pullRequest(number:$number) {
      reviews(first:100, author:"coderabbitai[bot]") {
        totalCount
        nodes { databaseId state body author { login } commit { oid }
          comments(first:100) { totalCount nodes { databaseId path line originalLine body author { login } replyTo { databaseId } } } }
      }
      comments(first:100) { totalCount nodes { body author { login } } }
    }`;
const dirOf = (path) => (String(path).includes("/") ? String(path).slice(0, String(path).lastIndexOf("/")) : "");
const baseName = (path) => String(path).slice(String(path).lastIndexOf("/") + 1);
export function followUpQuery(paths, oids) {
  const lines = [FOLLOWUP_QUERY_HEAD];
  const dirs = [...new Set(paths.map(dirOf))];
  oids.forEach((oid, i) => dirs.forEach((dir, j) => {
    lines.push(`    t${i}_${j}: object(expression: ${JSON.stringify(`${oid}:${dir}`)}) { ... on Tree { entries { name type mode } } }`);
  }));
  lines.push("  }\n}");
  return { query: lines.join("\n"), dirs };
}

// Every fixed file must be a regular file (mode 100644) at F and the head, and at
// R too unless it is new.
export function evaluateFollowUpModes(repository, files, oids, dirs) {
  const regular = (entry) => entry && entry.type === "blob" && entry.mode === 0o100644;
  for (const file of files) {
    const j = dirs.indexOf(dirOf(file.filename));
    for (let i = 0; i < oids.length; i += 1) {
      const tree = repository?.[`t${i}_${j}`];
      const entries = Array.isArray(tree?.entries) ? tree.entries : null;
      const entry = entries ? entries.find((candidate) => candidate?.name === baseName(file.filename)) : null;
      const atReview = i === 0;
      if (atReview && file.status === "added") {
        if (entry) return { kind: "not-covered", why: `${file.filename} already existed at the reviewed commit` };
        continue;
      }
      if (!regular(entry)) {
        return { kind: "not-covered", why: `${file.filename} is not a plain file at ${oids[i].slice(0, 9)} (type or mode changed)` };
      }
    }
  }
  return { kind: "ok", why: "" };
}

// The review of R and its findings. Returns { kind, why, findings }.
export function evaluateFollowUpReview(pullRequestNode, reviewedOid) {
  const unreadable = (why) => ({ kind: "unreadable", why, findings: [] });
  const notCovered = (why) => ({ kind: "not-covered", why, findings: [] });
  const reviews = pullRequestNode?.reviews;
  if (!Array.isArray(reviews?.nodes) || !Number.isInteger(reviews.totalCount)) {
    return unreadable("CodeRabbit's reviews could not be read");
  }
  // One read returns 100; a PR with more is refused outright rather than retried
  // forever (Luna round 1 on #1125).
  if (reviews.totalCount > reviews.nodes.length) return notCovered("CodeRabbit has posted more than 100 reviews on this PR");
  const atReviewed = reviews.nodes.filter((review) => isCodeRabbitLogin(review?.author?.login)
    && String(review?.commit?.oid || "").toLowerCase() === reviewedOid);
  const full = atReviewed.filter((review) => coderabbitReviewFindingCount(review?.body) !== null);
  // Every OTHER CodeRabbit review of that commit must be a plain thread reply: a
  // comment state, no finding count, and no new (non-reply) comment of its own,
  // so a second review there cannot hide a Major finding (Luna round 1 on #1125).
  for (const review of atReviewed) {
    if (full.includes(review)) continue;
    if (String(review?.state || "").toUpperCase() !== "COMMENTED") return notCovered(`another CodeRabbit review of that commit is ${review?.state}`);
    // A thread reply's review object has an empty body; any text could hold a
    // finding with no severity label (Luna round 2 on #1125).
    if (String(review?.body || "").replace(/<!--[\s\S]*?-->/g, "").trim()) {
      return notCovered("another CodeRabbit review of that commit has text of its own");
    }
    if (!Array.isArray(review?.comments?.nodes) || !Number.isInteger(review.comments.totalCount)) {
      return unreadable("another CodeRabbit review of that commit could not be read");
    }
    if (review.comments.totalCount > review.comments.nodes.length
      || review.comments.nodes.some((comment) => !comment?.replyTo && isCodeRabbitLogin(comment?.author?.login))) {
      return notCovered("another CodeRabbit review of that commit posted findings of its own");
    }
  }
  if (full.length === 0) return notCovered("CodeRabbit posted no findings in its review of that commit, so no code may change after it");
  if (full.length > 1) return notCovered("CodeRabbit posted more than one full review of that commit");
  const [review] = full;
  const expected = coderabbitReviewFindingCount(review.body);
  if (expected === 0) return notCovered("CodeRabbit posted no findings in its review of that commit, so no code may change after it");
  if (String(review.state || "").toUpperCase() !== "COMMENTED") return notCovered(`CodeRabbit's review is ${review.state}, not a comment`);
  const problem = coderabbitReviewBodyProblem(review.body);
  if (problem) return notCovered(problem);
  const comments = review.comments;
  if (!Array.isArray(comments?.nodes) || !Number.isInteger(comments.totalCount)) {
    return unreadable("CodeRabbit's review comments could not be read");
  }
  if (comments.totalCount > comments.nodes.length) return notCovered("CodeRabbit's review has more than 100 comments");
  const top = comments.nodes.filter((comment) => !comment?.replyTo && isCodeRabbitLogin(comment?.author?.login));
  if (top.length !== expected) {
    return notCovered(`CodeRabbit's review says it posted ${expected} findings but ${top.length} were found`);
  }
  const findings = [];
  for (const comment of top) {
    const severity = coderabbitFindingSeverity(comment.body);
    if (severity !== "minor" && severity !== "trivial") {
      return notCovered(`CodeRabbit rated its finding on ${comment.path || "a file"} ${severity || "with no readable severity"}`);
    }
    if (typeof comment.path !== "string" || !comment.path) return unreadable("a CodeRabbit finding names no file");
    findings.push({ id: comment.databaseId, path: comment.path, line: comment.line ?? comment.originalLine ?? null, severity, body: String(comment.body || "") });
  }
  const issueComments = pullRequestNode?.comments;
  if (!Array.isArray(issueComments?.nodes) || !Number.isInteger(issueComments.totalCount)) {
    return unreadable("the PR's comments could not be read");
  }
  // Only a complete comment list proves there is exactly one summary comment.
  if (issueComments.totalCount > issueComments.nodes.length) return notCovered("the PR has more than 100 comments");
  // The summary comment that describes R; an older one about another commit is ignored (Luna round 3).
  const walkthroughs = issueComments.nodes.filter((comment) => isCodeRabbitLogin(comment?.author?.login)
    && String(comment?.body || "").includes("<!-- pre_merge_checks_walkthrough_start -->")
    && String(comment?.body || "").toLowerCase().includes(`change_assessment_commit:"${reviewedOid}"`));
  if (walkthroughs.length !== 1) return unreadable("no single CodeRabbit summary comment describes the reviewed commit");
  const checks = coderabbitPreMergeChecks(walkthroughs[0].body, reviewedOid);
  if (checks.kind !== "ok") return { ...checks, findings: [] };
  return { kind: "ok", why: "", findings };
}

// Reached only when today's rules say "missing" and CodeRabbit completed a
// review of an earlier commit. `call` is readCodeRabbitRequirement's
// deadline-checked gh runner; a throw from it propagates (callers refuse).
export function readMinorFollowUp(call, { owner, name, number, pullRequest, verdict }) {
  const unreadable = (why) => ({ status: "unreadable", why: `the minor-follow-up check: ${why}`, headOid: verdict.headOid, reviewedOid: "" });
  const notCovered = (why) => ({ ...verdict, why: `${verdict.why}; a minor-only CodeRabbit review does not cover the later commits because ${why}`, followUpRefused: why });
  const step = (result) => (result.kind === "unreadable" ? unreadable(result.why) : result.kind === "not-covered" ? notCovered(result.why) : null);

  const chain = followUpChain(pullRequest);
  if (chain.kind !== "ok") return step(chain);
  const { reviewedOid, fixOid, tipMerges } = chain;
  const prPaths = (pullRequest?.files?.nodes || []).map((file) => file?.path).filter(Boolean);
  const compareArgs = (from, to) => ["api", `repos/${owner}/${name}/compare/${from}...${to}`];
  const fixes = JSON.parse(call(compareArgs(reviewedOid, fixOid)));
  // The finding paths are not known until the review is read, and the changed
  // files decide which trees that same read fetches, so check the comparison's
  // shape first and judge each file against the findings afterwards.
  const draft = evaluateFollowUpDiff(fixes, { chain: chain.chain, structuralOnly: true });
  if (draft.kind !== "ok") return step(draft);
  if (tipMerges.length > 0) {
    const base = String(pullRequest?.baseRefOid || "").trim().toLowerCase();
    if (!/^[0-9a-f]{40}$/.test(base)) return unreadable("the PR's base commit could not be read");
    const atFix = JSON.parse(call(coderabbitCompareArgs(owner, name, base, fixOid)));
    const atHead = JSON.parse(call(coderabbitCompareArgs(owner, name, base, verdict.headOid)));
    const tip = evaluateTipMerges(atFix, atHead);
    if (tip.kind !== "ok") return step(tip);
  }
  const oids = [reviewedOid, fixOid, verdict.headOid];
  const { query, dirs } = followUpQuery(draft.files.map((file) => file.filename), oids);
  const answer = JSON.parse(call(["api", "graphql", "-f", `query=${query}`, "-F", `owner=${owner}`, "-F", `name=${name}`, "-F", `number=${number}`]));
  if (Array.isArray(answer?.errors) && answer.errors.length > 0) return unreadable("GitHub returned errors with CodeRabbit's reviews");
  const repository = answer?.data?.repository;
  const review = evaluateFollowUpReview(repository?.pullRequest, reviewedOid);
  if (review.kind !== "ok") return step(review);
  const diff = evaluateFollowUpDiff(fixes, { chain: chain.chain, findingPaths: review.findings.map((finding) => finding.path) });
  if (diff.kind !== "ok") return step(diff);
  const modes = evaluateFollowUpModes(repository, diff.files, oids, dirs);
  if (modes.kind !== "ok") return step(modes);
  return {
    status: "reviewed",
    why: verdict.why,
    headOid: verdict.headOid,
    reviewedOid,
    via: "minor-follow-up",
    followUp: { reviewedOid, fixOid, findings: review.findings, files: diff.files },
  };
}

export function coderabbitRequirementUnreadableDenial(prefix, selector, why = "") {
  const which = selector ? String(selector) : "<number>";
  return (
    `${prefix}: could not read this pull request's CodeRabbit facts completely${why ? ` (${why})` : ""}, so it cannot ` +
    "tell whether it has the CodeRabbit review it needs (fail closed). Retry the merge in a minute, and do NOT post a " +
    `new @coderabbitai request for this; if it keeps failing, tell Mason the lookup is failing (gh pr view ${which}).`
  );
}

export function coderabbitReviewMissingDenial(prefix, selector, why, headOid) {
  const which = selector ? String(selector) : "<number>";
  const head = String(headOid || "").slice(0, 12) || "the head";
  return (
    `${prefix}: this pull request needs a clean CodeRabbit review of its current head before it merges ` +
    `(Mason, 2026-10-21), because ${why || "it qualifies"}, and CodeRabbit has not completed a review of ${head} ` +
    "(or of an earlier commit followed only by merges of main, or by narrow fixes for a minor-only review: Mason, 2026-10-26).\n\n" +
    "  1. If CodeRabbit's status shows a review in progress, wait up to 15 minutes.\n" +
    `  2. Otherwise post ONCE for this head:  gh pr comment ${which} --body "@coderabbitai full review"\n` +
    "     If it answers rate-limited, wait the time it states; if it is silent or skips, wait 30 minutes.\n" +
    "     Then post once more only if this head still has no review. If you have ALREADY posted twice\n" +
    "     for this head, do not post again: report the PR stuck (NEEDS MASON - ACTION REQUIRED).\n" +
    "     Rules: docs/reference/coderabbit-native-review.md.\n" +
    "  3. Fix or answer every thread it opens, reply, resolve, then retry the merge."
  );
}

// The deny text for "findings-at-head". Kept here so the Claude and Codex
// guards cannot drift into two different explanations of the same refusal.
export function codexBotFindingsDenial(prefix, selector, count) {
  const which = selector ? String(selector) : "<number>";
  const n = Number(count) > 0 ? Number(count) : 1;
  const noun = n === 1 ? "an unresolved comment" : `${n} unresolved comments`;
  const answered = n === 1 ? "it" : "them";
  return (
    `${prefix}: the Codex GitHub App has ${noun} raised against THIS EXACT commit, and nothing has ` +
    `answered ${answered}. Merging now lands code an automated reviewer flagged and nobody addressed.\n\n` +
    `  1. Read them:  gh pr view ${which} --comments      (author: chatgpt-codex-connector)\n` +
    "  2. Fix each real issue and push.\n" +
    "  3. For a genuine nitpick, reply with a one-line reason and RESOLVE the thread — resolving is\n" +
    "     the intended exit here, not a workaround. A thread resolved with no reply still blocks.\n\n" +
    "Only unresolved comments on the exact head block a merge. Threads already resolved, and findings " +
    "raised against earlier commits, do not."
  );
}
