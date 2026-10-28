## 2026-10-27 - Hold-latch changelog notes name every file form

- From the sixteenth Luna review of PR #1152: earlier notes in this PR now say that an unusual session id is hashed into `hold.<hash>.json`, that a missing, null or empty id uses the shared fallback file, and that two ids share a file only on a 128-bit hash collision. No behavior change.
