## 2026-10-27 - Hold-file wildcards are protected without the .json ending

- From Luna round 40 on PR #1152: a wildcard straight after "hold" (such as `hold-*` or `hold*`) is now treated as naming the hold files, with or without the ".json" ending, so a write or delete through it is refused. Broader wildcards that do not start with "hold" remain a follow-up.
