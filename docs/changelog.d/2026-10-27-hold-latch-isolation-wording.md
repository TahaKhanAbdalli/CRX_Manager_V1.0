## 2026-10-27 - Hold-latch docs qualify the per-session isolation claim

- From the twelfth Luna review of PR #1152: the docs now say that hook calls with no session id share the fallback hold file, and that hashed ids share a file only on a 128-bit hash collision. No behavior change.
