// MIGRATION LANDING GATE (Mason's autonomous-landing rule, 2026-09-26).
//
// The rule lets an agent apply a NON-destructive migration live with no in-chat
// ask — but only "under the same conditions" as an agent merge: the exact-SHA
// Sol review of the frozen final head is clean and every check is green.
// (CodeRabbit's approval was one of those conditions until Mason made CodeRabbit
// advisory on 2026-10-19.) The migration's own reviewer + Sol proofs (the rest
// of migration-apply-lib.mjs) prove the SQL was reviewed; they say nothing about
// the pull request carrying it. Sol's exact-SHA review of the introducing PR
// (HIGH, 2026-09-26) found exactly that gap: a migration could reach production
// before the PR's final reviews. This binds the apply to them.
//
// The apply must come from a checkout of the PR's branch where:
//   * the migration file is committed at HEAD and unchanged in the worktree, so
//     the SQL being applied is the SQL in the reviewed commit;
//   * HEAD is the open PR's headRefOid, and the PR targets main;
//   * CodeRabbit's latest verdict is APPROVED on that exact head, nothing is
//     CHANGES_REQUESTED, and the newest run of every check is green (CLEAN);
//   * a fresh gpt-6-sol/high merge proof is bound to that head and to GitHub's
//     real base — the same proof the merge gates require.
// Anything unreadable fails CLOSED. The same predicates as the merge gates are
// imported, never re-derived.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  headContainsBaseOnGitHub,
  proofSearchDirs,
  proofValid,
  pullRequestChecksGreen,
  pullRequestReviewBlocked,
} from "./codex-push-lib.mjs";
import {
  CODEX_THREADS_QUERY,
  CODEX_THREAD_PAGE_SIZE,
  coderabbitThreadCount,
  collectCodexThreads,
} from "./codex-bot-review-lib.mjs";

const PROTECTED_BRANCH_RE = /^(?:main|master|production)$/i;

function refuse(why) {
  return {
    ok: false,
    reason:
      `MIGRATION LANDING GATE: ${why}\n\n` +
      `Under Mason's autonomous-landing rule (2026-09-26) a live apply happens only after the pull request ` +
      `that carries the migration is ready to merge: every check is green, no review asks for changes, ` +
      `and a fresh exact-SHA gpt-6-sol proof (node scripts/write-codex-push-proof.mjs) is bound to that ` +
      `head. Apply from a clean checkout of the PR's branch with the migration committed, then merge right ` +
      `after. A destructive migration never applies through an agent — it is parked for Mason.`,
  };
}

export function evaluateLandingGate({
  checkoutDir,
  migName,
  // sha256 of the EXACT SQL being transmitted. The committed migration at the
  // PR's head must hash to the same value (Sol HIGH, round 2): checking only that
  // a same-named file is committed let different SQL — e.g. a same-named file the
  // source resolver found in another checkout — ride on this PR's approvals.
  queryHash,
  now = Date.now(),
  // Wall-clock deadline for EVERY git/gh call below (Sol HIGH, 2026-09-26). The
  // PreToolUse hook is killed at 15 seconds and a killed hook ALLOWS, so each call
  // is capped by the time left and the gate refuses — while it can still say so —
  // once too little remains. Callers with no hook timeout get a minute.
  deadlineMs,
  clock = () => Date.now(),
  runGit,
  runGh,
  listWorktrees,
} = {}) {
  const dir = String(checkoutDir || "");
  if (!dir) return refuse("the checkout the apply runs from is unknown (fail closed).");
  if (!/^[0-9a-f]{64}$/i.test(String(queryHash || ""))) {
    return refuse("the SQL being applied has no content hash to bind to the reviewed commit (fail closed).");
  }
  const deadline = Number.isFinite(deadlineMs) ? deadlineMs : clock() + 60_000;
  const RESERVE_MS = 500;
  const MIN_CALL_MS = 1_000;
  const left = () => deadline - clock() - RESERVE_MS;
  const OUT_OF_TIME = "ran out of time before every PR check finished; a hook cut off mid-check would ALLOW, so this refuses (fail closed). Retry, or apply through scripts/apply-migration-file.mjs, which has no hook time limit.";
  // Raw output: `git show` content must not be trimmed before it is hashed.
  const rawGit = runGit || ((args) => execFileSync("git", args, {
    cwd: dir, encoding: "utf8", timeout: Math.min(10_000, left()), stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024,
  }));
  const rawGh = runGh || ((args) => execFileSync("gh", args, {
    cwd: dir, encoding: "utf8", timeout: Math.min(15_000, left()), stdio: ["ignore", "pipe", "ignore"], maxBuffer: 16 * 1024 * 1024,
  }));
  class OutOfTime extends Error {}
  const timed = (call) => (args) => {
    if (left() < MIN_CALL_MS) throw new OutOfTime(OUT_OF_TIME);
    return call(args);
  };
  const git = timed(rawGit);
  const gh = timed(rawGh);
  try {
    return evaluate({ dir, migName, queryHash, now, git, gh, listWorktrees });
  } catch (error) {
    if (error instanceof OutOfTime) return refuse(OUT_OF_TIME);
    return refuse(`the check itself failed (${error?.message || error}); fail closed.`);
  }
}

function evaluate({ dir, migName, queryHash, now, git, gh, listWorktrees }) {
  const OUT = (error) => error?.constructor?.name === "OutOfTime";

  const stem = path.basename(String(migName || "")).replace(/\.sql$/i, "");
  if (!stem) return refuse("the migration name is missing (fail closed).");
  const rel = `supabase/migrations/${stem}.sql`;

  let head;
  let branch;
  try {
    head = String(git(["rev-parse", "HEAD"])).trim();
    branch = String(git(["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  } catch (error) {
    if (OUT(error)) throw error;
    return refuse(`could not read this checkout's HEAD (${error?.message || error}).`);
  }
  if (!/^[0-9a-f]{40}$/i.test(head)) return refuse("this checkout's HEAD is not a commit.");
  if (!branch || branch === "HEAD" || PROTECTED_BRANCH_RE.test(branch)) {
    return refuse(`the apply runs from ${!branch || branch === "HEAD" ? "a detached HEAD" : `"${branch}"`}, not from the pull request's own branch.`);
  }

  let committed;
  try {
    committed = git(["show", `HEAD:${rel}`]);
  } catch (error) {
    if (OUT(error)) throw error;
    return refuse(`${rel} is not committed at HEAD ${head.slice(0, 12)}, so the SQL cannot be the reviewed SQL.`);
  }
  // The same normalization scripts/apply-migration-file.mjs applies before hashing
  // and transmitting (CRLF → LF), so equal bytes on disk always compare equal.
  const committedHash = createHash("sha256").update(String(committed).replace(/\r\n/g, "\n")).digest("hex");
  if (committedHash !== String(queryHash).toLowerCase()) {
    return refuse(`the SQL being applied is not byte-identical to ${rel} in the reviewed commit ${head.slice(0, 12)} (committed ${committedHash.slice(0, 12)}, transmitted ${String(queryHash).slice(0, 12)}).`);
  }
  let dirty;
  try {
    dirty = String(git(["status", "--porcelain", "--untracked-files=all", "--", rel])).trim();
  } catch (error) {
    if (OUT(error)) throw error;
    return refuse(`could not confirm ${rel} is unchanged since HEAD (${error?.message || error}).`);
  }
  if (dirty) return refuse(`${rel} has uncommitted changes, so the SQL being applied is not the reviewed commit.`);

  let pr;
  try {
    pr = JSON.parse(gh(["pr", "view", branch, "--json",
      "number,state,baseRefName,baseRefOid,headRefOid,mergeStateStatus,reviewDecision,reviews,statusCheckRollup"]));
  } catch (error) {
    if (OUT(error)) throw error;
    return refuse(`could not find or read the open pull request for branch "${branch}" (${error?.message || error}).`);
  }
  const number = pr?.number ? `#${pr.number}` : "the pull request";
  if (String(pr?.state || "").toUpperCase() !== "OPEN") return refuse(`${number} is not open.`);
  if (String(pr?.baseRefName || "").toLowerCase() !== "main") return refuse(`${number} does not target main.`);
  if (String(pr?.headRefOid || "").toLowerCase() !== head.toLowerCase()) {
    return refuse(`${number}'s head on GitHub (${String(pr?.headRefOid || "?").slice(0, 12)}) is not this checkout's HEAD (${head.slice(0, 12)}) — push, or pull, so the reviewed commit is the one applied.`);
  }
  if (pullRequestReviewBlocked(pr)) return refuse(`${number} has an unresolved CHANGES_REQUESTED review.`);
  if (!pullRequestChecksGreen(pr)) {
    return refuse(`${number} is not merge-ready: mergeStateStatus must be CLEAN and the newest run of every check green.`);
  }
  // CodeRabbit is advisory (2026-10-19), but its unanswered threads block the
  // merge gates, so they block an apply too — otherwise production could take a
  // migration whose PR cannot merge (Luna round 2, HIGH). Unlike the merge gates'
  // fail-open notice, an apply FAILS CLOSED here like every other check in this
  // gate: an unreadable or partly read thread list refuses.
  let threads;
  try {
    threads = collectCodexThreads((cursor) => {
      const args = [
        "api", "graphql",
        "-f", `query=${CODEX_THREADS_QUERY}`,
        "-F", "owner={owner}",
        "-F", "name={repo}",
        "-F", `number=${pr.number}`,
        "-F", `first=${CODEX_THREAD_PAGE_SIZE}`,
      ];
      if (cursor) args.push("-F", `after=${cursor}`);
      return JSON.parse(gh(args))?.data?.repository?.pullRequest;
    });
  } catch (error) {
    if (OUT(error)) throw error;
    return refuse(`could not read ${number}'s review threads to check for unanswered CodeRabbit findings (${error?.message || error}); fail closed.`);
  }
  // The thread answer must describe the SAME head everything above checked
  // (Luna round 8): a push between the two lookups would otherwise apply A's
  // migration on the strength of B's threads.
  if (String(threads.headRefOid || "").toLowerCase() !== head.toLowerCase()) {
    return refuse(`${number}'s head moved while it was being checked (threads read at ${String(threads.headRefOid || "?").slice(0, 12)}, applying ${head.slice(0, 12)}); fail closed — re-run on the current head.`);
  }
  // Same counter as the merge gates: null = unreadable or partial → refuse.
  const coderabbitOpen = coderabbitThreadCount(threads);
  if (coderabbitOpen === null) {
    return refuse(`${number}'s review threads could not be read completely, so unanswered CodeRabbit findings cannot be ruled out (fail closed).`);
  }
  if (coderabbitOpen > 0) {
    return refuse(`${number} has ${coderabbitOpen} unresolved CodeRabbit comment thread(s). Reply on each (the fix or the reason) and resolve it before applying.`);
  }

  const baseSha = String(pr?.baseRefOid || "").trim();
  if (!/^[0-9a-f]{40}$/i.test(baseSha)) return refuse(`GitHub returned an unusable base for ${number} (fail closed).`);
  // The head must already contain that base (Sol HIGH, round 7), the same rule as
  // both merge gates: otherwise the merge that follows lands base-only commits the
  // Sol proof never reviewed alongside this migration.
  let headContainsBase = false;
  try {
    headContainsBase = headContainsBaseOnGitHub({ baseSha, headSha: head, gh });
  } catch (error) {
    if (OUT(error)) throw error;
    headContainsBase = false;
  }
  if (!headContainsBase) {
    return refuse(`${number}'s head ${head.slice(0, 12)} does not contain its base ${baseSha.slice(0, 12)}, or GitHub could not confirm it — merge origin/main into the branch, push, and re-run the checks and the Sol review.`);
  }
  let proven = false;
  for (const stateDir of proofSearchDirs(dir, listWorktrees || (() => git(["worktree", "list", "--porcelain"])))) {
    try {
      if (!existsSync(stateDir)) continue;
      for (const file of readdirSync(stateDir)) {
        if (!/^codex-review-[A-Za-z0-9_.-]+\.json$/.test(file)) continue;
        let data;
        try { data = JSON.parse(readFileSync(path.join(stateDir, file), "utf8")); } catch { continue; }
        if (proofValid(data, head, now, baseSha)) { proven = true; break; }
      }
    } catch { /* an unreadable directory holds no proof — keep looking */ }
    if (proven) break;
  }
  if (!proven) {
    return refuse(`no fresh gpt-6-sol/high proof is bound to ${number}'s head ${head.slice(0, 12)} and base ${baseSha.slice(0, 12)}.`);
  }
  return { ok: true, pullRequest: pr.number, head };
}
