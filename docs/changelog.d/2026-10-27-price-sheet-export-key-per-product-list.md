## 2026-10-27 — Each price sheet export keeps its own request key (To-Do 0.1, CodeRabbit on PR #1131)

- `src/pages/Products.tsx`: the pricing workbook export used one request key for every export. The database ties that key to the exact product list, so after a failed filtered export, a "Full price sheet" export (or a different filter) would reuse the key with a different list and be refused as a mismatch. The key is now held per exact product list: a retry of the same list replays the same export, and any other list gets its own key.
- Test: `Products.pricing-flow.test.tsx` "gives each exported product list its own export key…" (fails on the old code, passes now). The test's table stand-in now renders the page's filters.
