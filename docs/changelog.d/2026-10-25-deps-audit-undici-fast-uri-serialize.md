## 2026-10-25 — Patch build and test dependencies so the CI security audit passes

- New advisories (2026-10-25) failed `npm audit --audit-level=high` in "Lint, Type Check, Build" on every PR:
  undici (HIGH, under jsdom, tests only), fast-uri (moderate, under vite-plugin-pwa → workbox-build → ajv) and
  serialize-javascript (low, under workbox-build → @rollup/plugin-terser). None ships to users.
- `npm audit fix` (no `--force`) changed only `package-lock.json`: undici 7.30.0 → 7.30.1, fast-uri 3.1.8 → 3.1.9,
  serialize-javascript 7.0.5 → 7.1.4. `package.json` is unchanged.
