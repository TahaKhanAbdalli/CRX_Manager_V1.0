## 2026-10-22 — Plan: generic products record the delivered brand and its EPA number (step 1)

**What changed.** New plan `docs/plans/2026-10-22-product-brands-step1-PLAN.md`. It refreshes the August
product-data-model brand design (WP-3) against today's delivery, invoice and paperwork code. Step 1: a
generic product lists its acceptable brands, each with its own EPA number. Whoever loads the truck picks
the brand, or a split with amounts. The delivery receipt and email, delivery and order invoices, the
statement and the restricted-use (RUP) register for those invoices print the delivered brand's number.
Price and cost stay on the generic. It is built as two PRs, the brand list first, and the delivery rule
starts behind an admin on/off switch.

**Review.** An independent read-only review checked the draft against the code and made 35 findings, all
applied. The most important: the completion check must run inside the completion function after the
delivered amounts are written, not on the status change, which happens first. The RUP register's duplicate
check would also have dropped a split's second brand.

**Also.** To-Do row 2.8 added. Mason ranked it SHOULD for now (decision 13, 2026-10-22), declining the recommended MUST. There is a new
decision-log entry for Mason's 2026-10-22 calls: one cost on the generic, the loader picks and it's
required, delivery capture before receiving. UPDATE banners on the August master record and build plan say
WP-3 is replaced.

**No code or database change.** Nothing is built yet.
