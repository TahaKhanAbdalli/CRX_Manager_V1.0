#!/usr/bin/env node
// Mason's "skip coderabbit #<PR>" (coderabbit-skip-lib.mjs, 2026-10-22, per PR):
// the words that count, the waiver's binding to one PR and one session, its
// lifetime, cancelling, and the real prompt hook run end to end the way Claude
// Code runs it.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CODERABBIT_SKIP_MAX_AGE_MS, CODERABBIT_SKIP_MAX_BYTES, CODERABBIT_SKIP_PURPOSE, cancelCodeRabbitSkip, coderabbitSkipCommand, coderabbitSkipFileName,
  coderabbitSkipNotice,
  findCodeRabbitSkip, isSkipRepository, mayExist, recordCodeRabbitSkip, skipPullRequestFor, skipStateDirs, withdrawCodeRabbitSkip,
} from "./coderabbit-skip-lib.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
let pass = 0;
const ok = (value, message) => { assert.ok(value, message); pass++; };
const eq = (a, b, message) => { assert.deepEqual(a, b, message); pass++; };
const skip = (...pullRequests) => ({ kind: "skip", pullRequests });
// The parsed command without the saved text, which is checked on its own below.
const parsed = (text) => {
  const command = coderabbitSkipCommand(text);
  if (command?.kind !== "skip") return command;
  const { said: _said, ...rest } = command;
  return rest;
};
const UNNAMED = { kind: "skip-unnamed" };

// ── which words count, and which PRs they name ──────────────────────────────
eq(parsed("skip coderabbit #1018"), skip(1018), "the plain command names one PR");
eq(parsed("  Skip CodeRabbit #1018, Sol is enough"), skip(1018), "any case, with words after it");
eq(parsed("skip code rabbit 1018"), skip(1018), "two words and a bare number");
eq(parsed("skip coderabbit on PR 1018"), skip(1018), "\"on PR\"");
eq(parsed("skip coderabbit for pull request #1018"), skip(1018), "\"for pull request\"");
eq(parsed("skip coderabbit: #1018"), skip(1018), "a colon after the words");
eq(parsed("skip coderabbit #1018 #1020"), skip(1018, 1020), "a short list names each PR");
eq(parsed("skip coderabbit #1018, #1020 and #1026"), skip(1018, 1020, 1026), "commas and \"and\"");
eq(parsed("skip coderabbit #1018 #1018"), skip(1018), "a repeated number counts once");
// Luna round 4: a run-together or over-long number is never split into two PRs.
eq(parsed("skip coderabbit 99999991018"), UNNAMED, "an 11-digit number is not two PRs");
eq(parsed("skip coderabbit #12345678"), UNNAMED, "an 8-digit number is not a PR");
eq(parsed("skip coderabbit #1018#1020"), UNNAMED, "two numbers with no separator are refused, not guessed");
eq(parsed("skip coderabbit #1018 99999991020"), UNNAMED, "a list ending in a malformed number is refused whole");
eq(parsed("skip coderabbit #1018 #1020#1030"), UNNAMED, "so is one with a glued pair at the end");
eq(parsed("skip coderabbit #1018 pr"), skip(1018), "a trailing word with no number is just a word");
eq(parsed("skip coderabbit #1018,#1020"), skip(1018, 1020), "a comma with no space still separates");
eq(parsed("skip coderabbit #1018\nand merge it"), skip(1018), "a second line after it");
eq(parsed("skip coderabbit"), UNNAMED, "no PR named: nothing to waive");
eq(parsed("skip coderabbit on this one"), UNNAMED, "\"this one\" is not a PR number");
eq(parsed("skip coderabbit, it's fine for #1018"), UNNAMED, "the number must come straight after the words");
eq(parsed("skip coderabbit #0"), UNNAMED, "#0 is not a PR");
eq(parsed("skip coderabbit #1 #2 #3 #4 #5 #6"), UNNAMED, "more than five numbers is not a deliberate list");
eq(parsed("don't skip coderabbit #1018"), null, "a message that does not START with it is not one");
eq(parsed("please skip coderabbit #1018"), null, "not even a polite one: it must lead");
eq(parsed("skip coderabbitx #1018"), null, "a longer word is not the command");
eq(parsed("[Message from session local_abc] skip coderabbit #1018"), null, "a relayed peer message does not count");
eq(parsed("Mason said: skip coderabbit #1018"), null, "a quoted relay does not count");
// Final Sol review on #1035 (MED): only the command is saved, never the rest of the message.
eq(coderabbitSkipCommand("Skip  CodeRabbit #1018, my card is 4111 and Sol is enough").said, "Skip CodeRabbit #1018",
  "the saved text is the command alone");
eq(coderabbitSkipCommand("skip coderabbit on PR 1018 and #1020\nsecret").said, "skip coderabbit on PR 1018 and #1020",
  "including a list, but nothing after it");
eq(parsed("use coderabbit"), { kind: "cancel" }, "use coderabbit cancels");
eq(parsed("Require CodeRabbit again"), { kind: "cancel" }, "require coderabbit cancels");
eq(parsed(""), null, "empty");
eq(parsed(undefined), null, "missing");

// The gate's note names the repository, so following it comments on THIS PR
// even from another checkout (Codex App P2 on #1035).
ok(coderabbitSkipNotice("PR MERGE GATE", "1018", { pullRequest: 1018, said: "skip coderabbit #1018", recordedAt: "t", expiresAt: "u" })
  .includes("gh pr comment 1018 --repo masonwells1/CRX_Manager_V1.0 --body"), "the suggested PR comment names this repository");

// ── which repository a waiver covers (Codex App P2 on #1035) ────────────────
eq(isSkipRepository("masonwells1", "CRX_Manager_V1.0"), true, "this repository");
eq(isSkipRepository("MasonWells1", "crx_manager_v1.0"), true, "GitHub names are case-insensitive");
eq(isSkipRepository("croprxsolutions", "CRX_Manager_V1.0"), true, "this repository after its move to the organization");
eq(isSkipRepository("croprxsolutions", "other-repo"), false, "another repository in the organization gets none");
eq(skipPullRequestFor("https://github.com/CropRxSolutions/CRX_Manager_V1.0/pull/1018", 1018), 1018, "the organization's address for this repository");
eq(isSkipRepository("other", "repo"), false, "any other repository gets no waiver");
eq(isSkipRepository("masonwells1", "CRX_Manager_V1.0-fork"), false, "a look-alike name gets none");
eq(isSkipRepository(undefined, undefined), false, "an unknown repository gets none");
// Codex App P2 on #1035: the PR's own github.com address, host included.
eq(skipPullRequestFor("https://github.com/masonwells1/CRX_Manager_V1.0/pull/1018", 1018), 1018, "github.com, this repository, same number");
eq(skipPullRequestFor("https://GitHub.com/MasonWells1/crx_manager_v1.0/pull/1018/", 1018), 1018, "case and a trailing slash do not matter");
eq(skipPullRequestFor("https://github.example.com/masonwells1/CRX_Manager_V1.0/pull/1018", 1018), null, "an enterprise host with the same name gets none");
eq(skipPullRequestFor("http://github.com/masonwells1/CRX_Manager_V1.0/pull/1018", 1018), null, "plain http is not GitHub's answer");
eq(skipPullRequestFor("https://github.com/other/repo/pull/1018", 1018), null, "another repository gets none");
eq(skipPullRequestFor("https://github.com/masonwells1/CRX_Manager_V1.0/pull/1020", 1018), null, "a url for another number gets none");
eq(skipPullRequestFor("https://github.com.evil.example/masonwells1/CRX_Manager_V1.0/pull/1018", 1018), null, "a look-alike host gets none");
eq(skipPullRequestFor(undefined, 1018), null, "no url, no waiver");
eq(skipPullRequestFor("https://github.com/masonwells1/CRX_Manager_V1.0/pull/1018", undefined), null, "no number, no waiver");

// ── record, find, cancel ────────────────────────────────────────────────────
const temp = mkdtempSync(path.join(os.tmpdir(), "crx-cr-skip-"));
try {
  // A real git checkout with a second worktree: waivers live in the MAIN
  // checkout's state folder whichever worktree records or cancels them.
  const checkout = path.join(temp, "checkout");
  const worktree = path.join(temp, "worktree");
  mkdirSync(path.join(checkout, ".claude"), { recursive: true });
  const git = (...args) => {
    const r = spawnSync("git", ["-C", checkout, "-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { encoding: "utf8" });
    assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  };
  git("init", "-q");
  git("commit", "-q", "--allow-empty", "-m", "fixture");
  git("worktree", "add", "-q", "--detach", worktree);
  const dirs = skipStateDirs([checkout]);
  eq(dirs.length, 1, "a checkout resolves to one state folder");
  eq(skipStateDirs([worktree]), dirs, "a worktree resolves to the MAIN checkout's state folder");
  eq(skipStateDirs([checkout, worktree, path.join(checkout, ".claude")]), dirs, "folders of one repository share one folder");
  eq(skipStateDirs([path.join(temp, "not-a-repo")]), [], "a folder outside git resolves to none");
  eq(skipStateDirs([checkout], () => path.join(temp, "bare.git")), [], "a shared folder that is not <checkout>/.git resolves to none");
  eq(skipStateDirs([checkout], () => ""), [], "a failed lookup resolves to none");
  // Codex App P2 on #1035: git calls stay inside the caller's deadline.
  {
    const calls = [];
    const spy = (folder, timeoutMs) => { calls.push(timeoutMs); return path.join(checkout, ".git"); };
    eq(skipStateDirs([checkout, checkout, path.join(checkout, ".")], spy).length, 1, "the same folder three ways");
    eq(calls.length, 1, "costs ONE git call");
    calls.length = 0;
    eq(skipStateDirs([checkout], spy, { deadlineMs: 1000, now: () => 900 }), [], "100 ms left: no git call is started");
    eq(calls, [], "and none was");
    skipStateDirs([checkout], spy, { deadlineMs: 2000, now: () => 1000 });
    eq(calls, [900], "a call is capped to the time left (less a margin)");
    calls.length = 0;
    skipStateDirs([checkout], spy, { deadlineMs: 60_000, now: () => 0 });
    eq(calls, [3000], "and never longer than 3 seconds");
  }
  const session = "session-abc-12345";
  const PR = 1018;
  const now = Date.parse("2026-10-22T15:00:00Z");

  eq(recordCodeRabbitSkip({ dirs, sessionId: "bad id!", pullRequest: PR, said: "skip coderabbit #1018", now }), null,
    "an unusable session id records nothing");
  eq(recordCodeRabbitSkip({ dirs, sessionId: session, said: "skip coderabbit", now }), null, "no PR records nothing");
  eq(recordCodeRabbitSkip({ dirs, sessionId: session, pullRequest: 0, now }), null, "PR 0 records nothing");
  eq(recordCodeRabbitSkip({ dirs: [path.join(temp, "no-project", ".claude", "session-state")], sessionId: session, pullRequest: PR, now }), null,
    "a folder with no .claude/ is never created");
  const recorded = recordCodeRabbitSkip({ dirs, sessionId: session, pullRequest: PR, said: "skip coderabbit #1018", now });
  ok(recorded && recorded.purpose === CODERABBIT_SKIP_PURPOSE && recorded.pullRequest === PR, "the waiver is recorded for that PR");
  eq(findCodeRabbitSkip({ dirs, sessionId: session, pullRequest: PR, now })?.pullRequest, PR, "it is found for its own PR in its own session");
  eq(findCodeRabbitSkip({ dirs, sessionId: session, pullRequest: 1020, now }), null, "NEVER for another PR in the same session");
  eq(findCodeRabbitSkip({ dirs, sessionId: session, now }), null, "never when the gate cannot name the PR");
  eq(findCodeRabbitSkip({ dirs, sessionId: "another-session-99", pullRequest: PR, now }), null, "never in another session");
  eq(findCodeRabbitSkip({ dirs, sessionId: undefined, pullRequest: PR, now }), null, "never with no session id");
  ok(findCodeRabbitSkip({ dirs, sessionId: session, pullRequest: PR, now: now + CODERABBIT_SKIP_MAX_AGE_MS - 1 }), "still valid just inside 24 hours");
  eq(findCodeRabbitSkip({ dirs, sessionId: session, pullRequest: PR, now: now + CODERABBIT_SKIP_MAX_AGE_MS }), null, "expired at 24 hours");

  // A hand-written file claiming more than it may is no waiver.
  const file = path.join(dirs[0], coderabbitSkipFileName(session, PR));
  const write = (patch) => writeFileSync(file, JSON.stringify({ ...recorded, ...patch }));
  write({ expiresAt: new Date(now + 2 * CODERABBIT_SKIP_MAX_AGE_MS).toISOString() });
  eq(findCodeRabbitSkip({ dirs, sessionId: session, pullRequest: PR, now }), null, "a waiver claiming more than 24 hours is refused");
  write({ recordedAt: new Date(now + 3_600_000).toISOString(), expiresAt: new Date(now + 7_200_000).toISOString() });
  eq(findCodeRabbitSkip({ dirs, sessionId: session, pullRequest: PR, now }), null, "a waiver dated in the future is refused");
  write({ recordedAt: new Date(now + 1).toISOString(), expiresAt: new Date(now + 1 + CODERABBIT_SKIP_MAX_AGE_MS).toISOString() });
  eq(findCodeRabbitSkip({ dirs, sessionId: session, pullRequest: PR, now }), null, "even one millisecond in the future (Luna round 1)");
  write({ recordedAt: new Date(now).toISOString(), expiresAt: new Date(now + CODERABBIT_SKIP_MAX_AGE_MS + 1).toISOString() });
  eq(findCodeRabbitSkip({ dirs, sessionId: session, pullRequest: PR, now }), null, "and one claiming a millisecond over 24 hours");
  write({ sessionId: "another-session-99" });
  eq(findCodeRabbitSkip({ dirs, sessionId: session, pullRequest: PR, now }), null, "a file naming another session is refused");
  write({ pullRequest: 1020 });
  eq(findCodeRabbitSkip({ dirs, sessionId: session, pullRequest: PR, now }), null, "a file whose contents name another PR is refused");
  write({ purpose: "crx-coderabbit-skip-v1" });
  eq(findCodeRabbitSkip({ dirs, sessionId: session, pullRequest: PR, now }), null, "a session-wide v1 waiver is refused");
  write({});
  ok(findCodeRabbitSkip({ dirs, sessionId: session, pullRequest: PR, now }), "the exact 24-hour waiver the hook writes is accepted");
  // Luna round 5: an oversized file is never read, so it cannot outlast the gate.
  writeFileSync(file, JSON.stringify({ ...recorded, said: "x".repeat(CODERABBIT_SKIP_MAX_BYTES) }));
  eq(findCodeRabbitSkip({ dirs, sessionId: session, pullRequest: PR, now }), null, "a waiver file over the size limit is refused unread");
  let readAttempted = false;
  const huge = () => ({ isFile: () => true, size: 50 * 1024 * 1024 });
  eq(findCodeRabbitSkip({ dirs, sessionId: session, pullRequest: PR, now, stat: (f) => { readAttempted = true; return huge(f); } }), null,
    "a 50 MB file is refused on its size alone");
  ok(readAttempted, "the size check ran");
  eq(findCodeRabbitSkip({ dirs, sessionId: session, pullRequest: PR, now, stat: () => ({ isFile: () => false, size: 10 }) }), null,
    "something that is not a plain file is refused");
  writeFileSync(file, "not json");
  eq(findCodeRabbitSkip({ dirs, sessionId: session, pullRequest: PR, now }), null, "an unreadable file is no waiver");

  // Cancel removes every PR's waiver for this session, and only this session's.
  recordCodeRabbitSkip({ dirs, sessionId: session, pullRequest: PR, said: "skip coderabbit #1018", now });
  recordCodeRabbitSkip({ dirs, sessionId: session, pullRequest: 1020, said: "skip coderabbit #1020", now });
  recordCodeRabbitSkip({ dirs, sessionId: "another-session-99", pullRequest: PR, said: "skip coderabbit #1018", now });
  eq(cancelCodeRabbitSkip({ dirs, sessionId: session }), 2, "cancel removes both of this session's waivers");
  eq(findCodeRabbitSkip({ dirs, sessionId: session, pullRequest: 1020, now }), null, "and they are gone");
  ok(findCodeRabbitSkip({ dirs, sessionId: "another-session-99", pullRequest: PR, now }), "another session's waiver is untouched");
  cancelCodeRabbitSkip({ dirs, sessionId: "another-session-99" });

  // ── the real prompt hook, as Claude Code runs it ──────────────────────────
  const hook = path.join(HERE, "coderabbit-skip-prompt.mjs");
  const run = (prompt, sessionId = session, key = "session_id", from = checkout) => {
    const r = spawnSync(process.execPath, [hook], {
      input: JSON.stringify({ prompt, [key]: sessionId, cwd: from, hook_event_name: "UserPromptSubmit" }),
      encoding: "utf8",
      cwd: from,
      env: { ...process.env, CLAUDE_PROJECT_DIR: from },
    });
    eq(r.status, 0, `the hook exits cleanly for ${JSON.stringify(prompt.slice(0, 30))}`);
    return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput.additionalContext : "";
  };
  const live = (pullRequest = PR) => findCodeRabbitSkip({ dirs, sessionId: session, pullRequest });
  const files = () => readdirSync(dirs[0]).filter((n) => n.startsWith("coderabbit-skip-"));

  eq(run("merge it when it's ready"), "", "ordinary messages: silent");
  eq(files(), [], "and nothing recorded");
  eq(run("don't skip coderabbit on #1018"), "", "a message that does not start with it: silent");
  eq(files(), [], "and nothing recorded");
  ok(/CODERABBIT SKIP NOT RECORDED[\s\S]*did not name a pull request[\s\S]*skip coderabbit #<number>/.test(run("skip coderabbit")),
    "skip coderabbit with no PR is refused out loud, and the agent is told to ask which PR");
  eq(files(), [], "and nothing at all is waived");
  const said = run("skip coderabbit #1018, Sol is enough");
  ok(/CODERABBIT SKIP RECORDED[\s\S]*#1018 ONLY/.test(said), "skip coderabbit #1018 is recorded for that PR only, and the agent is told");
  eq(live()?.said, "skip coderabbit #1018", "the waiver keeps only the command, not \", Sol is enough\"");
  eq(live(1020), null, "it does not reach any other PR");
  eq(findCodeRabbitSkip({ dirs, sessionId: "another-session-99", pullRequest: PR }), null, "the hook wrote it for this session only");
  ok(/CODERABBIT SKIP RECORDED[\s\S]*#1020, #1026 ONLY/.test(run("skip coderabbit #1020 and #1026")), "a short list records each named PR");
  ok(live(1020) && live(1026), "both named PRs are waived");
  ok(/CODERABBIT SKIP CANCELLED/.test(run("use coderabbit again")), "use coderabbit cancels them all");
  eq(files(), [], "and every waiver is gone");
  eq(run("use coderabbit"), "", "cancelling with nothing to cancel: silent");
  // Final Sol review on #1035: a waiver recorded in one worktree is cancelled from another.
  ok(/CODERABBIT SKIP RECORDED/.test(run("skip coderabbit #1018", session, "session_id", worktree)), "a waiver recorded from the worktree");
  ok(live(), "lands in the main checkout's state folder");
  ok(/CODERABBIT SKIP CANCELLED/.test(run("use coderabbit", session, "session_id", checkout)), "is cancelled from the main checkout");
  eq(findCodeRabbitSkip({ dirs: skipStateDirs([worktree]), sessionId: session, pullRequest: PR }), null,
    "and a gate in the worktree no longer finds it");
  ok(/CODERABBIT SKIP RECORDED/.test(run("<system-reminder>Linked sessions now: none</system-reminder>\nskip coderabbit #1018")),
    "the app's reminder block in front of his words is not part of them");
  cancelCodeRabbitSkip({ dirs, sessionId: session });
  eq(run("<system-reminder>a</system-reminder>\nnote</system-reminder>\nskip coderabbit #1018"), "",
    "a reminder that is not cleanly whole is not stripped, so the words do not lead");
  eq(files(), [], "and nothing recorded");
  // Codex may send the id camelCased; the gate reads either, so the hook must too (Luna round 2).
  ok(/CODERABBIT SKIP RECORDED/.test(run("skip coderabbit #1018", session, "sessionId")) && live(),
    "a camelCase sessionId records the waiver for that session");
  // A copy that cannot be deleted must never be reported as cancelled (Luna round 2).
  {
    const refused = () => { throw new Error("EPERM"); };
    eq(withdrawCodeRabbitSkip({ dirs, sessionId: session, remove: refused }), { removed: 0, stillLive: true },
      "a waiver whose delete fails is reported still live");
    ok(live(), "and it really is still there");
    // Luna round 3: a copy that can be neither deleted nor read must still count.
    const waiverFile = path.join(dirs[0], coderabbitSkipFileName(session, PR));
    writeFileSync(waiverFile, "unreadable for now");
    eq(withdrawCodeRabbitSkip({ dirs, sessionId: session, remove: refused }), { removed: 0, stillLive: true },
      "an unreadable, undeletable waiver file is reported still live");
    // Codex App P2 on #1035: a file or folder that cannot be checked counts as still holding it.
    const denied = (code) => () => { const e = new Error(code); e.code = code; throw e; };
    eq(mayExist("x", denied("EACCES")), true, "a permission error counts as still there");
    eq(mayExist("x", denied("EPERM")), true, "so does EPERM");
    eq(mayExist("x", denied("EIO")), true, "and any other error");
    eq(mayExist("x", denied("ENOENT")), false, "only a missing file counts as gone");
    eq(mayExist("x", denied("ENOTDIR")), false, "or a missing folder");
    eq(withdrawCodeRabbitSkip({ dirs, sessionId: session, remove: refused, exists: (f) => mayExist(f, denied("EACCES")) }).stillLive,
      true, "a withdraw that cannot check a file reports the waiver still live");
    eq(withdrawCodeRabbitSkip({ dirs, sessionId: session, list: denied("EACCES") }).stillLive,
      true, "a withdraw that cannot list a folder reports a waiver still live");
    eq(withdrawCodeRabbitSkip({ dirs: [path.join(temp, "missing", ".claude", "session-state")], sessionId: session }).stillLive,
      false, "a folder that does not exist holds no waiver");
    // Final Sol review on #1035: no folder resolved (git lookup failed) cannot confirm a cancel.
    eq(withdrawCodeRabbitSkip({ dirs: [], sessionId: session }).stillLive, true, "no folder to check: NOT confirmed cancelled");
    eq(withdrawCodeRabbitSkip({ dirs, sessionId: "" }).stillLive, true, "no usable session id: NOT confirmed cancelled (Codex App P2)");
    eq(withdrawCodeRabbitSkip({ dirs, sessionId: session }), { removed: 1, stillLive: false }, "a normal withdraw removes it");
    eq(files(), [], "no waiver is left behind");
  }
  // End to end: "use coderabbit" from a folder outside git cannot reach the waiver folder.
  {
    const outside = path.join(temp, "outside");
    mkdirSync(outside, { recursive: true });
    recordCodeRabbitSkip({ dirs, sessionId: session, pullRequest: PR, said: "skip coderabbit #1018" });
    ok(/CODERABBIT SKIP NOT CANCELLED/.test(run("use coderabbit", session, "session_id", outside)),
      "use coderabbit where the waiver folder cannot be found says NOT CANCELLED");
    ok(live(), "(the waiver really is still there)");
    cancelCodeRabbitSkip({ dirs, sessionId: session });
  }
  ok(/CODERABBIT SKIP NOT RECORDED/.test(run("skip coderabbit #1018", "")), "with no session id it says the waiver was not saved");
  ok(/CODERABBIT SKIP NOT CANCELLED/.test(run("use coderabbit", "")), "and use coderabbit with no session id says NOT CANCELLED");
  ok(!existsSync(path.join(dirs[0], coderabbitSkipFileName("", PR))), "and writes nothing");
} finally {
  rmSync(temp, { recursive: true, force: true });
}

console.log(`coderabbit-skip-lib: ${pass} assertions passed`);
