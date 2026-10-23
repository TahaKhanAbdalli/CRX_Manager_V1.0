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
// parent counts and latest commit statuses (newest commit last).
export const CODERABBIT_REQUIREMENT_QUERY = `
query($owner:String!, $name:String!, $number:Int!) {
  repository(owner:$owner, name:$name) {
    pullRequest(number:$number) {
      headRefOid
      baseRefOid
      labels(first:100) { totalCount nodes { name } }
      files(first:100) { totalCount nodes { path } }
      commits(last:100) {
        totalCount
        nodes { commit { oid parents { totalCount } status { contexts { context state description creator { login } } } } }
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

// Did CodeRabbit itself mark this commit "Review completed"?
export function coderabbitCompletedCommit(commit) {
  const contexts = commit?.status?.contexts;
  if (!Array.isArray(contexts)) return false;
  return contexts.some((context) =>
    String(context?.context || "").trim().toLowerCase() === "coderabbit"
    && isCodeRabbitLogin(context?.creator?.login)
    && String(context?.state || "").trim().toUpperCase() === "SUCCESS"
    && /^review completed\b/i.test(String(context?.description || "").trim()));
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
    if (coderabbitCompletedCommit(commit)) {
      return { status: "reviewed", why, headOid, reviewedOid: String(commit.oid).trim().toLowerCase() };
    }
    const parents = commit?.parents?.totalCount;
    // Only a merge commit may sit between the reviewed commit and the head.
    if (!(Number.isInteger(parents) && parents >= 2)) break;
  }
  return { status: "missing", why, headOid, reviewedOid: "" };
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
    why: `${verdict.why}; the PR's own changes differ between the reviewed commit and the head, so a merge since the review changed them`,
  };
}

export function coderabbitRequirementUnreadableDenial(prefix, selector) {
  const which = selector ? String(selector) : "<number>";
  return (
    `${prefix}: could not read this pull request's labels, files and commit statuses completely, so it cannot ` +
    "tell whether it is a money PR that needs a CodeRabbit review (fail closed). Retry the merge in a minute; if " +
    `it keeps failing, tell Mason the lookup is failing (gh pr view ${which}).`
  );
}

export function coderabbitReviewMissingDenial(prefix, selector, why, headOid) {
  const which = selector ? String(selector) : "<number>";
  const head = String(headOid || "").slice(0, 12) || "the head";
  return (
    `${prefix}: this pull request needs a clean CodeRabbit review of its current head before it merges ` +
    `(Mason, 2026-10-21), because ${why || "it qualifies"}, and CodeRabbit has not completed a review of ${head} ` +
    "(or of an earlier commit followed only by merges of main).\n\n" +
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
