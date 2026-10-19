## 2026-10-18 — New Order keeps an edited form when a retry opens the earlier order (replay-binding batch 2)

Sol final review of PR #951 (HIGH, fixed before landing):

- **Edits are no longer lost.** When a New Order retry is refused because the form changed since an
  earlier attempt that already created an order, the screen still opens that earlier order, but it
  now keeps the current form as a draft instead of deleting it. The edits are in no order, so they
  must stay recoverable. The warning says the form was kept.
- **Two different forms no longer share a retry key.** The form's change check joined free-text
  fields with `|`, so an order name `A|B` with notes `C` looked the same as name `A` with notes
  `B|C`. It is now JSON-encoded.
- **A true retry keeps its key (CodeRabbit).** Each order type's change check is now exactly the
  arguments that order sends, built once and sent as built. Before, a field the order never sends
  (a rush order's date or name, or a space after the PO number) gave a retry a fresh key, so a
  retry after a lost response could create a second order.
- **The kept draft is current (CodeRabbit).** The draft saves half a second after typing; the
  recovery now writes it immediately before opening the earlier order, from the latest form state
  (`flushLatest`), so an edit made while the request was pending is kept too (Codex).
- **Older tests send a key (Codex).** Six gate probes in `smoke-create-direct-order-po.sql` and
  `smoke-blend-ticket-fractional-cents.sql`, and 19 browser-test calls in `tests/e2e/` (18 to
  `create_direct_order`, one to `create_planned_holds`), called these functions without a retry
  key; once the migration is live they would hit `IDEMPOTENCY_KEY_REQUIRED` instead of the gate
  they test. Each now sends its own fresh key (and the direct-order chain expects the wrapper's
  `AUTH_REQUIRED` and `ACTOR_MISMATCH`, which it raises before the renamed body's own messages;
  CodeRabbit), and the call-site test fails if an e2e call to any
  of the thirteen leaves the key out. The blend-ticket chain's container proof still passes; the
  direct-order chain needs live data the container lacks, so it runs live after the apply.
- **A below-cost retry matches its approved request (Codex).** Approving a below-cost order
  adds the reason to that attempt's notes (direct) or items (rush). A retry under the same key
  sent the request without it, so after a lost response the replay was refused and the kept draft
  could later be resubmitted as a duplicate order. New Order now remembers the reason approved
  under each key (`createBelowCostReasonMemo`) and sends it again on a retry under that key; keys
  rotate when the form changes, so a reason never reaches a different request.
- **The gauntlet chain asserts the new contract (Codex).** `smoke-gauntlet-core-blend-guards.sql`
  reused a committed blend-ticket order's key with a different order number and notes and
  expected the cached result; the wrapper now refuses that. The chain retries with the exact
  arguments (cached result), then proves the changed request is refused with
  `IDEMPOTENCY_INTENT_MISMATCH` and creates no order. It needs live data, so it runs live after
  the apply.
- **Proof:** `src/__tests__/replayBindingBatch2CallSites.test.ts` fails if either recovery block
  clears the draft or skips the immediate save, or if either order call stops sending exactly
  the arguments its key's change check covers; `src/hooks/useFormDraft.test.ts` proves the
  immediate save cancels a pending one.
