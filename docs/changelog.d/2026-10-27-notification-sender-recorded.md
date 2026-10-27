## 2026-10-27 — Notifications show who sent them

- Mason (2026-10-26). New migration
  `20261027080300_notification_sender_recorded.sql` (row 999, NOT APPLIED, placeholder stamp/row)
  adds `notifications.created_by`, which a BEFORE INSERT trigger always sets to the signed-in sender
  (the database sets it, not the app). Notices from server functions stay unsigned (system).
- The ~12 screen flows that alert other staff (large order, credit limit, dispatch, delivery
  done...) keep sending; each notice now carries its sender. Server-built notification text (one
  RPC) is a possible follow-up.
- Screens: Notifications page and the bell panel show "From <name>" when another person sent it
  (`withSenderNames` in `src/lib/activityLogger.ts`, names from `profile_public_view` as in
  ActivityFeed). The panel's duplicate local `Notification` interface is replaced by the shared type;
  `src/types/index.ts` and `src/types/supabase.ts` gain `created_by`.
- Proof (local replay of main `fe258c2f`, synthetic data): every notification a signed-in user
  sends stores that user as the sender, whatever the client sent; sending to others is still allowed for admins and reps; no other cell changed;
  booking scenarios identical to main; `activityLogger.test.ts` covers the name lookup.
- Not verified: live table state; `.claude/schema-registry.json` is regenerated from live after apply.
