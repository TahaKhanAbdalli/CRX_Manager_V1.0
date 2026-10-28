## 2026-10-27 - Malformed session ids no longer share a hold file

- From the seventh Luna review of PR #1152: a session id is JSON-encoded before it is hashed into `hold.<hash>.json`, so two malformed ids that UTF-8 would turn into the same replacement character get different files.
