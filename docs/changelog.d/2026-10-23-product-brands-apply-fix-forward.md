## 2026-10-23 — Product brands: fix-forward PR carries the live apply after #1050 merged first (step 1, PR A)

**What changed.** PR #1050 (merge `9ec42855c`, 19:24 UTC) was merged on GitHub before its migration `20261022086500_product_brands.sql` was applied. Production therefore shipped the Brands section on Product Detail without its `product_brands` table, and the section showed its "could not load brands" message with a retry. The rest of the product page is unaffected. The apply gate only applies a migration from an open pull request, so this fix-forward PR carries the apply, as #976 did for #965 on 2026-10-20. It adds only this note; the migration file is already on `main`, unchanged and reviewed.

**Proof.** Recorded on the pull request: the live apply result, the smoke chain (`SMOKE_PASS_ROLLBACK`) and a look at the Brands section on the live site.
