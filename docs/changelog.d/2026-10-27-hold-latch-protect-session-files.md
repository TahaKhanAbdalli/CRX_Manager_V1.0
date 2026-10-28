## 2026-10-27 - Per-session hold files are protected by name

- From the fifth Codex GitHub App review of PR #1152: the review-proof guard's protected-name list now covers `hold-<session>.json` and `hold.<hash>.json` as well as the shared latch file, so a shell command that deletes or forges a session's hold without naming the state folder (for example a bare `find -name … -delete`) is refused, just as it already was for the shared file.
