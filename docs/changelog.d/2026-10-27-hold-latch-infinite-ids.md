## 2026-10-27 - Infinite numeric session ids get their own hold files

- From Luna round 31 on PR #1152: numeric session ids are spelled with String() before hashing, so positive infinity, negative infinity and NaN no longer share one hold file.
