## 2026-10-27 - Hold-file comments name the length limit and hashed form

- From the fourth Luna review of PR #1152: the hold-latch comments and guardrails doc now say a session id is used as-is only when it is 1-128 lowercase `[a-z0-9_-]` characters, and that any other id lands in `hold.<hash>.json`. No behavior change.
