## 2026-10-26 — Margin floor: a margin just under its floor never reads as the floor (To-Do 0.2)

CodeRabbit round 4 on PR #1102: on the Products list, a tier at 14.996% net under a 15% floor showed
"15.00% net · under 15% floor", because two-decimal rounding reached the floor. A flagged margin now
never rounds up to its floor ("14.99% net · under 15% floor"). The rule lives in
`formatNetMarginPercent` (`src/lib/marginFloors.ts`), with unit and page tests for the boundary.
Sol's final review found the same rounding on the product page's Margin Floor card warning ("Tier 2
is at 15.00% — under the 15% floor"); the card now uses the same helper and has its own test.

Sol (HIGH) on the next head: the card told admins "The price sheet warns on any tier below it", but
the price sheet's low-margin warning is To-Do 0.1 and not built yet. The card now says tiers are
flagged on the product page and Products list only, and that the price sheet does not check floors yet.

Codex GitHub App (P2): the live smoke chain `smoke-set-product-margin-floors.sql` needed an active
product with no floor, so it would fail once every product had one. It now takes any active product
(preferring one without a floor) and clears its floor inside the rolled-back transaction. The
real-schema proof runs the chain with no floors and with every active product floored, and checks
the floors are unchanged afterwards.
