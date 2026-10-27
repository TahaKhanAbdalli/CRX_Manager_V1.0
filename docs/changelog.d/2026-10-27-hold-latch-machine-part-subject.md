## 2026-10-27 - A stop order to agents latches the hold

- From the third Codex GitHub App review of PR #1152: a stop followed by an -ing verb is skipped as description only when the clause also names a machine part (hook, gate, guard, check, test, script, job, workflow, build, CI, loop, sweep …). Agents and sessions count as people being addressed, so "All agents must stop pushing", "Both agents must stop deploying" and "the agent should stop pushing to main" latch, and no longer clear an existing hold.
