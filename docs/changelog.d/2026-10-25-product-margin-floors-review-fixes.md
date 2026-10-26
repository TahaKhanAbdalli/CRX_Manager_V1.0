## 2026-10-25 — Margin floor review fixes (To-Do 0.2, Luna round 2)

Fixes found in review of the margin floor change, before it went live:

- `set_product_margin_floors` (`20261025210000_product_margin_floors.sql`, not yet applied) now
  refuses a malformed product id as `MARGIN_FLOOR_ITEM_INVALID`; before, it was reported as a
  duplicate product. The same product twice (in any letter case) is still
  `MARGIN_FLOOR_PRODUCT_DUPLICATE`.
- The product page's Margin Floor card no longer shows one product's floor on another product when
  a save or load finishes after the page has moved on; it resets when the product changes.
- Typing `15.00` against a saved 15% floor no longer counts as a change.
- The live smoke chain (`smoke-set-product-margin-floors.sql`) now checks only the history rows it
  adds itself, so a product whose floor was set and later cleared no longer fails it (Codex App).
- The Products list's edit table (`EditableDataTable`) locks every cell and Cancel while a save
  runs, so an edit typed during a slow save of floors or prices is no longer silently dropped when
  the save closes edit mode (Codex App).
- The product page's "unsaved changes" warning now also covers an unsaved margin floor edit, so
  leaving the page or refreshing with only the floor changed asks first (Codex App).
- After a floor save on the Products list, a floor reload that fails now says the list could not
  be reloaded instead of reporting success; the product page shows the floor card only once that
  product has loaded, so a previous product's margins are never judged against this floor
  (CodeRabbit).
- When that floor reload fails, the floor just saved is still shown on its product, while the
  others show "?" and the column stays read-only; when the whole list fails to reload instead,
  the other products keep their floors and the column stays editable (CodeRabbit).
- Proof: `node scripts/smoke/prove-product-margin-floors-real-schema.mjs` re-run, PASS; the smoke
  chain passes in that database on a fresh product and on one with earlier cleared history.
