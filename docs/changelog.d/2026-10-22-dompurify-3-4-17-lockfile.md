## 2026-10-22 — dompurify 3.4.16 → 3.4.17 (lockfile only; unblocks the required CI check)

On 2026-10-22 npm published a critical advisory against `dompurify <=3.4.16`
(GHSA-cg2g-xh64-v4q7, GHSA-mrv2-3pqr-j5jr, GHSA-c6gr-qvv4-5v3f). The required check
"Lint, Type Check, Build" runs `npm audit --audit-level=high`, so it failed on every PR,
whatever the PR changed (first seen on #1040, run 39831683604).

`dompurify` is a transitive, optional dependency of `jspdf@4.2.1` (`^3.3.1`), which lazily
imports it only inside `jsPDF.html()`; `src/` never calls that. `npm audit fix` moved it to
3.4.17, the first patched version, inside jspdf's existing range: only the
`node_modules/dompurify` entry in `package-lock.json` changes (version, resolved URL,
integrity). `package.json` is unchanged.

**Proof observed:** before the fix `npm audit --audit-level=high` exited 1 (1 critical); after
it exits 0 ("found 0 vulnerabilities"). `npm ls dompurify` shows `jspdf@4.2.1 → dompurify@3.4.17`.
typecheck, lint, build and `npm test` (432 files, 5975 passed, 123 skipped, 0 failed) pass, and
`node scripts/verify-deps.mjs` passes. The built `dist/assets/purify.es-*.js` contains 3.4.17. In
the local dev server, the module jspdf imports reported `DOMPurify.version === "3.4.17"`;
`sanitize()` stripped an `onerror` handler, a `<script>` and a `javascript:` href while keeping
the text; `jsPDF.html()` on that payload produced a one-page PDF and ran none of it; and the
app's own quote PDF generator produced a one-page quote that rendered correctly on screen. With
real (unmocked) jspdf under vitest, `generateInvoicePdf` produced a valid invoice PDF whose text
reads correctly (header, bill-to, two lines, $345.00 balance due).

**Not verified:** no production screen exercises DOMPurify, so there is no in-app user flow to
click through; the proof above calls jspdf's `html()` path directly.
