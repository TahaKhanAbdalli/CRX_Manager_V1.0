## 2026-10-26 — Minor dependency bumps (re-delivers Dependabot #1107)

- `lucide-react` 1.59.0 → 1.61.0 (icon library, ships to users; minor release, no icon removals used by the app).
- `typescript-eslint` 8.71.2 → 8.72.0 (lint tooling only, never ships to users), plus its `@typescript-eslint/*`
  sub-packages and `ignore` 7.0.12 → 7.0.14 in `package-lock.json`.
- Same `package.json` / `package-lock.json` change as Dependabot #1107, re-delivered as an agent PR because CodeRabbit
  skips bot-authored PRs (precedent: #969 replaced #960). No source or database changes.
