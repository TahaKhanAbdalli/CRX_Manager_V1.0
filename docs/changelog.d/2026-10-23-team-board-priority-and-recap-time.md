## 2026-10-23 — Team Board ranks 'normal' deliveries correctly; recap uses the completion time

- Migration `20261022086000_team_board_priority_and_recap_completed_at.sql` (migration-history row 979,
  PR #1042 follow-ups 1 and 2). `get_team_board_deliveries()` ranked a priority value deliveries
  cannot have ('medium'), so a 'normal' delivery sorted after a 'low' one; it now ranks urgent, high,
  normal, low. `get_yesterday_delivery_recap()` timed and ordered completed deliveries by their last
  edit; it now uses `completed_at` (falling back to `updated_at`). Display only: same callers, same
  rows, same shape.
- `src/components/team/TodaysDeliveries.tsx`: the card border colour map used the same 'medium' key,
  so every 'normal' delivery was drawn grey like a 'low' one; it now keys on 'normal'.
- Live read 2026-10-23: all 108 deliveries are 'normal' and every completed one has `completed_at`
  with no later edit, so the order shown today does not change; the 'normal' cards turn blue.
- Proof: `scripts/smoke/prove-team-board-display-fixes-real-schema.mjs` (real-schema container:
  wrong order before, right order after, everything else identical, re-apply refused, putting either
  old expression back reproduces the old result).
