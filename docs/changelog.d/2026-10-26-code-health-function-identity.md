## 2026-10-26 — Code-health findings keyed by the function they sit in

- `scripts/check-code-health-lib.mjs` now keys every size and complexity finding by its owner
  chain from the file's syntax tree (for example `complexity QuoteBuilder > saveQuote`,
  `max-depth DispatchBoard > fetchData`), using the `typescript-eslint` parser. Before, ESLint's
  wording grouped every unnamed arrow as "Arrow function" and nesting findings by rule only, so
  fixing one grandfathered function could make room for a different new one in the same file
  (Codex GitHub App P2 and Luna round 3 on #1117).
- The baseline was regenerated with the new keys; 3 entries still have no derivable name.
- Deliberately unchanged: a grandfathered function may still grow worse without failing. Freezing
  its measured size would block any edit to the largest screens until they are split.
- Proof: `node scripts/check-code-health.test.mjs` parses real code and covers both swap cases
  (an arrow handler and a deep block moving to another function); `npm run check:code-health`
  passes on the regenerated baseline.
