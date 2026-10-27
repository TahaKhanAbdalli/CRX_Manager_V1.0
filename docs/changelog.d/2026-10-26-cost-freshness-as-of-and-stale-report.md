## 2026-10-26 — Cost freshness: "as of" date and stale-cost report (To-Do 0.7, small part)

No database change. Admins only, like cost itself (cost fields come through `get_admin_cost_fields`).

- Products list: a read-only "Cost as of" column next to Cost (shown with the Margins toggle), amber when
  the cost has not changed in 90 days or has no date. The admin CSV downloads carry a "Cost As Of" column.
- Reports > Operational > **Stale Costs**: every active product whose cost has not changed in more than 30,
  90 (default), 180 or 365 days, or has no date at all, undated first and then oldest first, with cost,
  vendor, the date and its age in days, and a CSV export.
- The date is `products.cost_updated_date` as a Central business date; the governed pricing apply sets it
  when the cost itself changes, so a cost re-entered at the same value keeps its old date.
- New `src/lib/costFreshness.ts` with tests; the Reports paging test covers 1,500 products across two
  pages and keeps the tab from a sales rep.
- Checked in the running app on 2026-10-26: 594 of 595 active products over 90 days, 583 with no date.
- The supplier-evidence rollout stays parked (`app_settings.supplier_cost_basis_enabled` stays false).
- The To-Do row 0.7 update goes in the session's records PR, not here (every queued PR edits that file).
