## 2026-10-27 - What a safe verb carries out must be harmless too

- From the Codex App review of PR #1152: after a safe verb that carries out what follows it (retrying, rerunning, reporting, looping), every remaining word of the clause must also be on the safe list, so "make the CI job stop retrying database writes" latches the hold while "the hook should stop retrying on a red check" still does not.
