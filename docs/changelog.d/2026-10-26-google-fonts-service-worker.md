## 2026-10-26 — Google Fonts load again on the live site

- The app's fonts (Inter, Barlow Semi Condensed) never loaded on croprxsolutions.app: every page logged
  `net::ERR_FAILED` twice and the UI fell back to system fonts.
- Cause: the PWA service worker (`vite.config.ts` workbox `runtimeCaching`) fetched the font files itself. A
  service-worker fetch is checked against the CSP `connect-src`, which does not list `fonts.googleapis.com` or
  `fonts.gstatic.com`, so the fetch was blocked.
- Fix: removed the two font `runtimeCaching` rules. The browser now loads the fonts directly, which the existing
  `style-src` / `font-src` already allow. The security header in `vercel.json` is unchanged. Offline, the app shows
  system fonts unless the browser's own HTTP cache still has them — the same fallback every user saw before this fix.
