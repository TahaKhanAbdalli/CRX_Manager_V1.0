## 2026-10-20 — replay-binding batch 3b: voiding an order never erases money recorded on its draft

- Sol's exact-head review (HIGH) found that batch 3b's fix for voiding a fulfilled order cancels
  the order's draft invoice by zeroing its paid, prepay and write-off cents without checking them
  first, so a draft that already carried a recorded amount would have had it erased. Before batch
  3b, that void rolled back.
- A first fix checked the amounts on the draft as the loop had read it. Sol's next review (HIGH)
  showed a write landing between that read and the update could still be erased. The final fix puts
  the condition in the update itself: `_void_order_impl_20260714`'s draft UPDATE now matches only a
  row whose paid, prepay, write-off and credit cents are all zero (PostgreSQL re-checks that on the
  latest row after any concurrent writer finishes), and when it updates no row the branch refuses
  with `ORDER_VOID_DRAFT_HAS_APPLIED_MONEY` and the whole void rolls back.
- The postflight and the real-schema prover strip the three 3b edits and check the pinned md5; the
  smoke chain gives a draft a 100-cent payment and proves the void is refused and changes nothing,
  and the prover proves that case fails with the zero-money condition or the refusal taken out.
- The screens show a plain message for the new code (`src/lib/errorSanitizer.ts`).
- Live check, 2026-10-20 22:10 UTC: none of the 9 draft invoices has any of those amounts nonzero,
  so nothing changes for today's data.
