## 2026-10-27 - Signed-zero session ids keep separate hold files

- From the eighth Luna review of PR #1152: a session id of `-0` is spelled out before hashing so it never shares a hold file with `0`, and a test pins that an id ending in a line break is hashed rather than used as a file name.
