## 2026-10-26 — Vitest 4 → 5 so jsdom 30.1.x works; jsdom pin removed

- `vitest` and `@vitest/coverage-v8` `^4` → `^5.0.5`, `jsdom` exact `30.0.0` → `^30.1.3` (test tooling only, never
  ships to users), with their sub-dependencies in `package-lock.json`. No product code or test changes.
- `src/setupTests.ts` now imports `@testing-library/jest-dom/vitest` (jest-dom's documented Vitest entry) instead of
  the bare `@testing-library/jest-dom`. Vitest 5 no longer picks up jest-dom's global `jest.Matchers` types, so
  `npm run typecheck` reported 2,621 "`toBeInTheDocument` does not exist" errors; the Vitest entry registers the
  same matchers and types them on `vitest`'s `Assertion`. A throwaway check confirmed `toBeInTheDocument` still
  fails on a detached element and passes on an attached one.
- Root cause of the 13 failures seen with jsdom 30.1.3 (`docs/changelog.d/2026-10-26-deps-jsdom-30.md`): Vitest's
  jsdom environment replaces `URL.createObjectURL` and converts a jsdom `Blob` to a Node `Blob` by reading jsdom's
  private internals (`blob[implSymbol]._buffer`). jsdom 30.1 renamed `_buffer` to `_bytes` and the impl symbol is no
  longer an own property, so Vitest 4.1.12 (the newest 4.x) threw `Cannot read properties of undefined (reading
  '_buffer')` whenever code under test called `URL.createObjectURL` on a jsdom Blob/File.
  - `BulkTicketUpload.test.tsx` (8): the component makes a preview URL for each chosen photo.
  - `QuoteBuilder.test.tsx` (5): "Preview Quote" makes a URL for the quote PDF; it threw, so the preview with its
    "Email to Grower" button never opened. Tests that stub `URL` themselves were unaffected.
- Vitest 5.0.5 reads `_bytes ?? _buffer` and finds the impl symbol properly, so both files pass unchanged (92/92).
  Vitest 5 keeps the same `vite` peer range (`^6 || ^7 || ^8`).
