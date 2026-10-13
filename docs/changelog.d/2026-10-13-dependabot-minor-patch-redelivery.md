## 2026-10-13 — Library updates: minor-and-patch group of 10 (re-delivered from #899)

Dependabot PR #899 bumped ten libraries. CodeRabbit skips bot-authored PRs ("Bot user detected"),
and the merge gates require CodeRabbit APPROVED on the exact head, so this PR re-applies the same
versions on top of current `main`. #879 and #886 did the same for #863 and #883.

| Package | From | To |
| --- | --- | --- |
| `@sentry/react` | 10.76.0 | 10.76.2 |
| `@supabase/supabase-js` | 2.117.2 | 2.117.3 |
| `@tmcw/togeojson` | 7.1.2 | 7.1.3 |
| `lucide-react` | 1.52.0 | 1.56.0 |
| `mapbox-gl` | 3.32.0 | 3.33.0 |
| `@playwright/test` (dev) | 1.63.0 | 1.64.0 |
| `@sentry/vite-plugin` (dev) | 5.4.0 | 5.4.1 |
| `@types/node` (dev) | 26.6.4 | 26.6.5 |
| `typescript-eslint` (dev) | 8.71.0 | 8.71.2 |
| `vite` (dev) | 7.3.6 | 7.3.7 |

`package.json` and `package-lock.json` are byte-identical to #899's head. Neither file changed on
`main` between #899's base (`af0ce0c4c`) and this branch's base. The lockfile's other changes are
npm deduplication.
- The Sentry browser packages now share one `@sentry/core` 10.76.2 instead of nesting their own copies.
- `@sentry/bundler-plugins` (dev) moves to 10.76.2.
- A few dev-only `glob`, `path-scurry`, `lru-cache` and proxy-agent entries are hoisted to the top level.

No migration and no source change.

**Proof observed** on this tree.
- `npm ci` reported 0 vulnerabilities.
- `npm run typecheck`, `npm run lint`, `npm run build` and `npm run test` passed: 391 files, 5,571 tests.
- `npm run test:agent-workflows`, `node scripts/verify-deps.mjs --force` and `npm audit --audit-level=high` passed, with 0 vulnerabilities.
- In a real browser against the production build (`npm run preview`), the login page rendered. Its lucide icon drew as an SVG, and the bundle logged no console errors.
- On the dev server, three of the updated libraries were exercised directly.
  - **Supabase:** the app's own `src/lib/db.ts` client returned `getSession()` with no error. A signed-out `products` read returned HTTP 200 with 0 rows, because RLS correctly hides them.
  - **`@tmcw/togeojson`:** it parsed a KML field boundary into one named `Polygon` feature.
  - **`mapbox-gl`:** 3.33.0 drew a GeoJSON field polygon (fill and outline) on a WebGL canvas.

**Not verified here.** No local Mapbox token exists, so satellite tiles were not loaded, and the
mapbox test used an inline style. Sentry event delivery was not exercised.
