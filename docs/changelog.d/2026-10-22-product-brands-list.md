## 2026-10-22 — Products list their real brands, each with its own EPA number (step 1, PR A)

**What changed.** New migration `20261022086500_product_brands.sql` (migration-history row 975, not yet
applied). It adds `product_brands`, one row per acceptable brand of a product: name, its own EPA
registration number, manufacturer, a "currently sourced" switch, restricted-use flag (or "not
confirmed") and signal word. It also adds the admin-only `upsert_product_brand` operation that writes it:
- retry-safe, with the key bound to the caller and the request;
- an edit must carry the version it read;
- one name per product;
- brands are retired, never deleted.

Everyone signed in with an active account can read the list; nobody can write it directly.

The product page gets a **Brands** section. Admins add, edit or retire brands. The existing EPA lookup
checks a typed EPA number and can fill in the signal word and restricted-use status. Brand names already
written inside the product name are offered as one-click suggestions, and brands can be copied from
another size of the product. Everyone else sees the list read-only. The EPA-lookup helpers moved from
`src/pages/ProductDetail.tsx` to `src/lib/epaLookupClient.ts` so both places share them; the product
page's behavior is unchanged.

Nothing reads brands yet. Quotes, prices, cost, deliveries and paperwork are unchanged. Picking the
brand at delivery and printing it is PR B of `docs/plans/2026-10-22-product-brands-step1-PLAN.md`.

**Proof.**
- `node scripts/smoke/prove-product-brands.mjs` runs on a throwaway PostgreSQL 17 database. It uses the
  live helper bodies and Supabase-style default grants. All phases pass:
  - the migration applies and its postflight passes;
  - 35 behavior tests pass (admin add and edit, replay, intent mismatch, name, EPA and field checks,
    versions, no direct writes, who can read and write, and an index on each profile reference);
  - a re-apply is refused by the preflight;
  - the live smoke chain passes and rolls back;
  - a copy that over-grants write access is refused by the postflight and leaves nothing behind.
- New unit and screen tests: `src/lib/productBrands.test.ts` and
  `src/components/products/ProductBrandsSection.test.tsx`. The existing product page tests still pass.
- After apply, `scripts/smoke/smoke-upsert-product-brand.sql` runs on live (spec `upsert_product_brand`).

**Review fixes (Codex App, three P1s).**
- The Brands section is keyed by product, so going straight from one product's page to another starts it
  fresh; an open form can't be saved onto the next product.
- In "Copy from another product", a late reply for an earlier pick is ignored, so the brands copied are
  the picked product's.
- `created_by` and `updated_by` each get an index, so a profile change never scans the brand table.
