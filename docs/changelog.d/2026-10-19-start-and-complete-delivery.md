## 2026-10-19 — Deliveries list: Mark Delivered is one server call (closes the Goal 5 two-call gap)

Goal 5 left one gap: on the Deliveries list, **Mark Delivered** on a *scheduled* delivery made two
server calls (`confirm_delivery`, then `complete_delivery`), so signal lost in the instant after the
first answered left the delivery **In Progress** (nothing deducted or billed, driver told).

- **New RPC `start_and_complete_delivery`** (migration `20261019220000_start_and_complete_delivery`).
  It starts a scheduled delivery (by calling `confirm_delivery`, unchanged) and completes it (by
  calling `complete_delivery`, unchanged) in one transaction: the delivery ends completed or
  nothing changed. No stock, invoice or period logic is retyped.
- **It takes the chosen business date** (`p_delivered_on`, America/Chicago). "Today" completes at
  the server's now(); an earlier date completes at 17:00 UTC of that date (noon CDT, 11 AM CST; the same instant the app
  already sent for a past date). So a "today" completion whose request reaches the server just
  after Chicago midnight keeps the chosen day. A date after today, more than a year back, or not
  a real date is refused; the one-year bound is checked after the retry receipt lookup, so an exact
  retry of a completion saved on the oldest allowed date still replays after midnight (Codex). (Such a just-after-midnight completion is dated the previous day, so for
  an order with field allocations it is handled like any backdated completion: the split drafts are
  flagged for the office instead of created automatically.)
- **Authorization before any saved answer.** It runs `complete_delivery`'s own test (active admin or
  sales rep, or the assigned driver) before looking up its retry receipt, so a driver taken off the
  delivery or a deactivated account cannot replay a completion.
- **Retry key required and bound** to the caller and the exact request (SHA-256 fingerprint of the
  actor and every argument, through `check_idempotency_intent`): an exact retry returns the saved
  result; a reused key for a different person or request is refused. The fingerprint carries the
  chosen date, so an exact retry across midnight still replays.
- **Grants:** EXECUTE for `authenticated` only; SECURITY DEFINER, `search_path = public, pg_temp`.
- **App (`src/pages/Deliveries.tsx`):** Mark Delivered / Mark Complete makes this one call after the
  signal check; the dialog-session, "details changed" and `runCriticalAction` guards stay. The
  "started but not completed" message is gone because that state can no longer happen.

**Proof.** Container: `node scripts/smoke/prove-start-and-complete-delivery-real-schema.mjs` →
START_AND_COMPLETE_DELIVERY_PROOF_PASS (chain fails before the migration and passes after; a
completion refused after the start leaves the delivery scheduled; seven mutations each turn it red;
the existing delivery chains still pass). Browser preview (2026-10-19, the app against a local
stand-in server whose completion call ran the real function in that container): (1) reply dropped
after the server committed: the app's automatic same-key retry got the saved result, one completion,
2 units of stock, one invoice; (2) reply dropped and signal kept off: the dialog stayed open, the
delivery was already **Completed** (never In Progress), and tapping again with signal replayed the
saved result with no second stock move; (3) a closed-period date refused after the start: the
delivery stayed **Scheduled** with no start record; (4) no signal: only the signal check was sent,
"No signal… NOT completed" shown. (The preview ran the function before the review fixes, which
added the authorization-before-receipt order and the past-date bound; those are covered by the
container proof.) End state: three completed, 6 units moved, three invoices, zero In
Progress.
