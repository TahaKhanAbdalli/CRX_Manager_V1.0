## 2026-10-23 — Remove unused code before the developer handoff (part 1, no money files)

Deletes code nothing in the app calls, so the incoming developer has less to read. App behavior does not change.

- `src/lib/loadSheetPdf.ts` and its test: the old summary-style load sheet. The Deliveries page "Load Sheet" button has printed Delivery Receipt PDFs (`deliveryPdf.ts`) since March 2026.
- `src/components/jobs/jobTagFilter.ts` and its test: the tag rule lives in `jobMatchesClientFilters` (`jobFilters.ts`), which never imported this file.
- `src/lib/notificationTriggers.ts`: `runPeriodicNotificationChecks`, `checkLowStockNotifications` and `checkExpiringQuoteNotifications` (the database job `run_morning_notification_checks` replaced them in U18), and `notifyOrderNeedsPricing` (never called since its caller was removed; `create_rush_order` now alerts admins server-side).
- `PRODUCT_SEARCH_LIMIT` in `ProductSearchPicker.tsx` (never read).
- The `@types/proj4` dev package: `proj4` ships its own types.

Found with `knip` (run with `npx`, not added to the project) and confirmed by searching tests, scripts, hooks, Edge Functions and docs. `docs/reference/code-patterns.md` and `qa-testing.md` no longer describe the removed load sheet.
