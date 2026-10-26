## 2026-10-26 - Inventory holds and retired-on-order guards are live

**What changed.** Migration `20261025090000_inventory_holds_and_retired_on_order_guards` (PR #1101, history row 983) was applied live at 9:25 AM Central, ledger version `20261026142537`, before PR #1101 merged as `e55412c9a`. Since then:

- a retired product with stock on an open purchase order stays in the on-order view and is never flagged for reorder (To-Do 0.13);
- the public hold path makes manual holds only, and the daily integrity check alerts on a hold stuck on a dead job or with no live planned quote (To-Do 0.14);
- deleting a product that has stock holds is refused instead of wiping the holds (holds half of To-Do 6.9).

**Proof.** The live rolled-back smoke chain `inventory_holds_guards` returned SMOKE_PASS_ROLLBACK and left no [E2E] rows behind. The 9 crop-program holds on Q-2026-1994 were untouched. The production Inventory screen loads, and `get_inventory_position` returns 200. `.claude/schema-registry.json` was regenerated from live: one new applied name and the two new alert types.
