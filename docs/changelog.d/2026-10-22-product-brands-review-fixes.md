## 2026-10-22 — Product brands: three fixes from the Codex review (step 1, PR A)

**What changed.** The Codex App review of PR #1050 found three problems before anything went live. All three are fixed in the same PR.
- **Switching products.** The Brands section is now keyed by product. Going straight from one product's page to another starts it fresh, so an open brand form can't be saved onto the next product.
- **Copy from another product.** If the admin picks one product and then another, the late reply for the first pick is ignored. The brands copied are always the picked product's.
- **Indexes.** Migration `20261022086500_product_brands.sql`, still not applied, now indexes `created_by` and `updated_by`. A profile change no longer scans the brand table.

**Proof.**
- New screen test for the late copy reply. It fails with the fix removed.
- Docker proof test B12 checks both indexes. It also fails with an index removed.
- `node scripts/smoke/prove-product-brands.mjs` passes all phases with 35 behavior tests.
- The migration-access classifier still rates the file `changesAccess: false` and `rewrites: false`.
