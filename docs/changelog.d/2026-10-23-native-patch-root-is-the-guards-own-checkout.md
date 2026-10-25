## 2026-10-23 - native patch: the allowed folder is the guard's own checkout

Sol gate review of `544c954` on PR #1083 (HIGH). The "stay inside the repository" rule also counted the
event's working directory (and the git root above it) as allowed, so a patch event run from a home
directory or an unrelated checkout could edit files there. The only allowed folder is now the checkout the
guard file itself lives in (`guardCheckoutRoot()`, two levels above `.codex/hooks/`), which is the
repository the hook command was launched for; it is passed in by the hook's entry point and not taken from
the event. Tests cover an event working directory in an unrelated folder, the explicit root overriding
`repoDir`, and the real entry point run from an unrelated folder. One consequence: a session in one
checkout can no longer patch files in a sibling worktree by absolute path; do that from inside that worktree.
