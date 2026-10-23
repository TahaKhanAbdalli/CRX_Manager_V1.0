## 2026-10-22 — five more screens say "could not be loaded" instead of "No … found" (To-Do List 10.5, second non-money PR)

- **Jobs:** a failed read shows "This list could not be loaded" with Try again (on phones too), and hides the bulk
  bar, the Needs Dispatch filter, the "most recent jobs" notice and the totals row while it shows.
- **Field Setup:** a failed read of the field or of its billing splits shows "This field could not be loaded" with
  Try again, instead of "Field not found". Before, a failed billing-split read showed the form with no splits, and
  Save sends the whole split list, so saving would have erased the field's saved splits.
- **Compliance:** the Licenses, RUP Sales Register and Field Listing tabs use the shared failed state with Try
  again; RUP Products, which had none, now shows it instead of "No RUP products".
- **Brand vs Generic:** the mappings table shows the shared failed state instead of a red line above "No mappings
  yet".
- **Office Cockpit:** a tile whose own read failed (unbilled jobs, needs dispatch, ready to post, chemical drafts,
  watchdog flags, upcoming jobs, expiring licenses, overdue AR) says it could not be loaded and shows "(–)" for its
  count, instead of a green "No …" all-clear line. Only the newest cockpit load may set the tiles.
- **Products:** if a reload fails while the Deactivate dialog is open, the dialog closes and its confirm is refused.
- **Settings:** when the app settings fail to load, "Settings could not be loaded" with Try again replaces the
  company, defaults, surcharge, auto-draft, guardrail, field-sheet and notice forms, and every settings save is
  refused. Before, those forms showed blank defaults, and saving one would have overwritten the real values. The
  users list is unaffected.
- Not covered yet: the money screens.
