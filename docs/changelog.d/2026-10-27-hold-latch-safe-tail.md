## 2026-10-27 - What follows a safe verb must be harmless too

- From the Codex App and Luna reviews of PR #1152: after a safe verb (retrying, refusing, blocking …), every remaining word of the clause must also be on the safe list, so "make the CI job stop retrying database writes" and "make the gate stop refusing database writes" latch the hold, while "the hook should stop retrying on a red check" and "make the gate stop refusing a branch that is behind main" still do not.
