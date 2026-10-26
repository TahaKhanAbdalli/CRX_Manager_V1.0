## 2026-10-26 — production builds upload source maps to the right Sentry org

Every production build on Vercel logged `[sentry-vite-plugin] Error: ... Project not found`
while creating the release and uploading source maps, so Sentry showed production errors
against minified code. The deploy itself still succeeded. `vite.config.ts` fell back to the
org name `crx-solutions`; the real org is `crop-rx-solutions` (project `crx-manager`). The
fallback now names the real org. `docs/manual/SERVICES_AND_ACCOUNTS.md` records the fix and
where to look if the upload fails again.
