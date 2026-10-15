## 2026-10-15 — Supplier Pricing quick-quote tests wait for the supplier list to load

`src/pages/SupplierPricing.test.tsx` › "never reuses an older PDF path after the selected PDF
changes during upload" failed once in CI (Actions run 38739235160, PR #927) with "upload called
0 times". The page draws the empty "Linked Product" dropdown before the supplier list arrives,
and five quick-quote tests picked a link as soon as that empty dropdown appeared. Under CI
load the list had not arrived yet, so the pick did nothing and "Stage quick quote" was still
disabled. The staging under test never started.

A new helper, `chooseQuickQuoteLink`, now waits until the link's option exists and the Stage
button is enabled, then confirms the pick took. All five quick-quote tests use it. Two of them
("removes a Quick Quote link…" and "blocks Quick Quote staging while a refresh…") check that
staging does *not* happen, so before this fix they could pass without ever making a selection.

No product code changed. The page is correct: a person cannot pick from an empty list or
click the disabled button.

Proof: delaying the supplier list by 50 ms reproduced the CI failure exactly (same line, ~1.1 s)
and failed all five original tests. With the fix, all five pass at 50 ms, and the CI-failing
test also passes at 300 ms. The whole file passed 20 consecutive runs without coverage and
20 with `--coverage`.

The sibling flake in `LoaderWorksheetsPanel.test.tsx` (run 38741624554, PR #929) is fixed
separately by the concurrent flaky-Vitest session (branch `claude/fix-flaky-vitest-20261015`),
which was already editing that file.
