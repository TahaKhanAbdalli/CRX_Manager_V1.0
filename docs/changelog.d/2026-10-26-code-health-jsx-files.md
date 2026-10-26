## 2026-10-26 — Code-health ratchet measures `.jsx` files and fails on unmeasured ones

- The repo's ESLint config only registers TypeScript files, so the ratchet's size and
  complexity limits silently skipped `.jsx` modules (Codex GitHub App P2 on #1117). The ESLint
  options now live in `sizeLintOptions()` in `scripts/check-code-health-lib.mjs`, register
  `src/**/*.{js,jsx,ts,tsx}` with JSX parsing, and are shared by the runner and its test.
- Any rule-less ESLint notice (such as "File ignored because no matching configuration was
  supplied") now fails the check instead of passing an unmeasured file.
- Proof: `node scripts/check-code-health.test.mjs` lints `.jsx`, `.tsx`, `.js`, and `.ts` probes
  through the real repo config and expects `max-params probe` in each; with the fix removed it
  fails on the `.jsx` probe. A temporary `src/probe.jsx` made `npm run check:code-health` report
  `max-params probe`; without it the check passes.
