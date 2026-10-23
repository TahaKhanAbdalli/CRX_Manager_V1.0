## 2026-10-22 - Smoke chains follow the admin-only purchase cost and governed pricing; Goal 3 follow-ups closed

- `scripts/smoke/smoke-adversarial-money-inventory-closeout.sql`: the bulk vendor-document imports send
  no cost, and the admin prices the line with `set_purchase_order_item_costs`, as the app does since
  `20261021140000` made purchase cost admin-only. A rep's and an admin's import of one document match
  again, and the chain passes live (`SMOKE_PASS_ROLLBACK`). The app behaviour is unchanged; the
  KNOWN_ISSUES entry is resolved and records why the stricter refusal stays.
- `scripts/smoke/smoke-field-invoice-loop.sql`: its two products are priced through the governed
  preview/apply path, because a sale has needed a positive catalog cost since `20260812115237`
  (`COST_BASIS_REQUIRED`) and cost is set only through that path.
- `govern_invoice_order_money_lifecycle`, `field_invoice_loop` and `adversarial_money_inventory_closeout`
  each returned `SMOKE_PASS_ROLLBACK` in a disposable copy of the real schema with every migration
  through `20261022022000` replayed. The first two stay off the live database because they post an
  invoice.
- The invoice-list cost of `invoice_post_version` needs no change: all three columns its allocation
  lookup reads (`invoice_id`, `split_invoice_id`, `invoice_item_id`) are indexed live.
