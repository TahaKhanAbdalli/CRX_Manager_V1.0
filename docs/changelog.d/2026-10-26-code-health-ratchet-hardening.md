## 2026-10-26 — Code-health ratchet hardened after Luna round 1

- Findings are keyed by rule and the function ESLint names, so fixing one grandfathered
  function cannot make room for a different new one in the same file.
- The baseline must allow nothing its base-branch copy does not (`CODE_HEALTH_BASE`, which CI
  sets to the PR's base branch), so a change cannot raise its own allowance.
- `.js` and `.jsx` files under `src/` are now scanned too.
- Known limit: renaming a grandfathered file counts as new debt under the new path.
- Proof: `node scripts/check-code-health.test.mjs` covers the replacement case; the regenerated
  baseline passes `npm run check:code-health`; a baseline with an added allowance, compared
  against a base without it, is refused.
