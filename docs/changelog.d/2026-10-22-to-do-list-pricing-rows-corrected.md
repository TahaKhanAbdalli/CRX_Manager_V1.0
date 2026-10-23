## 2026-10-22 — To-Do List: pricing rows corrected after a built-vs-switched-off check

- Mason asked whether the pricing and cost-tracking work was already built but not switched on. A code check found
  no pricing-plan slice finished and switched off, but more groundwork than the list said. `docs/manual/TO_DO_LIST.md`
  rows 0.1 (price sheet), 0.5 (cost beside quote lines), 0.6 (profit at sale-time cost), 0.7 (cost freshness, and the
  one real switch, `supplier_cost_basis_enabled`, which stays parked) and 1.3 (quote line identity) now say what exists
  and what is missing, with file and migration references.
- Row 13.6 records that the backup freshness check is live and its failure email reaches Mason (PR #1030).
- Documentation only.
