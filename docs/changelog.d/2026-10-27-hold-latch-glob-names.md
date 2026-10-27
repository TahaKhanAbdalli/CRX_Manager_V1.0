## 2026-10-27 - Wildcard spellings of the hold file names are protected

- From Luna round 28 on PR #1152: the review-proof guard's protected-name list also matches wildcard spellings of the hold files that end in `.json` (such as `hold*.json`), so they cannot be deleted that way. A general wildcard-aware check for every protected file is a separate follow-up.
