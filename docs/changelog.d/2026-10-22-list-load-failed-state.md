## 2026-10-22 — a list that fails to load says so, instead of "No … found" (To-Do List 10.5, non-money screens)

- New shared `LoadFailedState` (in `src/components/ui/EmptyState.tsx`): "This list could not be loaded. This does not
  mean the records are gone." with a **Try again** button. Only a page's newest read sets or clears the error,
  so a slow older read cannot hide a newer list. `DataTable` and `EditableDataTable` show it when given `loadError`
  (and `onRetry`).
- Now used on Customers, Fields (list and map), Products, Vendors, Vehicles, Crop Programs, Program Tracker,
  Notifications and the Settings users list. Before, a failed read left these lists empty and showed "No customers
  yet" and similar, which staff could take to mean the records were gone.
- Crop Programs also hides **New Program** while its list has failed to load: saving rewrites the whole program
  list, so saving from an empty, failed list would have erased the saved programs.
- A deliberate silent refresh (after a rep assignment on Customers, or applying a pricing file on Products) keeps
  its rows on screen and its own "saved, but reload" message, as before.
- Not covered yet: money screens, and Jobs, Field Setup, Compliance, Brand vs Generic and Office Cockpit, which
  other open pull requests are changing.
