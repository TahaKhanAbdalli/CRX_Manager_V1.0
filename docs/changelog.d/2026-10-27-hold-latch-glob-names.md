## 2026-10-27 - Wildcard spellings of the hold file names are protected

- From Luna rounds 28 and 29 on PR #1152: the review-proof guard's protected-name list also matches spellings of the hold files where a wildcard, bracket class or brace list follows `hold` and the name ends in `.json` (such as `hold*.json`, `hold[-.]*.json` or `hold{-a,-b}.json`).
