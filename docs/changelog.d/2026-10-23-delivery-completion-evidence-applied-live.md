## 2026-10-23 - Recorded: delivery completions need server-checked proof (row 973 live)

- Migration `20261022075000_delivery_completion_evidence` (migration-history row 973, PR #1024, merged as
  `e685b5d6c`) was applied live 2026-10-23 12:39:30 UTC (7:39 AM Central), ledger version `20261023123930`,
  through the migration-apply guard on Mason's in-chat `I approve`.
- Read-only live check 12:48 UTC: `complete_delivery` and `start_and_complete_delivery` each have one overload
  ending in `p_evidence, p_evidence_ref`; `_is_accepted_delivery_evidence_object` is VOLATILE; both new triggers,
  the four new storage policies, the five `deliveries.completion_*` columns and `get_delivery_receipt_recipient`
  exist. The full ledger is 1054 rows; the effective ordering high-water is `20261022075000`.
- The live site serves bundle `index-Ckax77dz.js`; its Deliveries, Delivery Detail and Field Stop chunks carry
  the new completion-proof and receipt calls, which no build before #1024 had.
- Row 973, a new live capture in `migration-history.md`, the `CURRENT_STATE.md` ledger header,
  `rpc-functions.md`, and the schema registry now reflect live. The driver-receipt item (KI-72 (a)) is closed in
  `KNOWN_ISSUES.md` and its closing record is appended to `docs/manual/archive/KNOWN_ISSUES-history-2026-10.md`.
