## 2026-10-27 — A notification's sender can't be rewritten

- Codex App finding on #1164 (P2). `20261027080300_notification_sender_recorded.sql` (not yet
  applied) now runs its `notifications_stamp_sender` trigger on UPDATE as well as INSERT. For a
  signed-in user an update keeps the original `created_by`, so marking a notice read still works
  but the recorded sender can't be changed or cleared. Server functions keep what they set.
- Proof: on a throwaway Postgres 15 with a stand-in `notifications` table, the migration's postflight
  passed. A signed-in insert stored the real sender even when the client sent another one, the
  recipient's mark-read kept that sender through two update attempts, and an owner insert stayed
  unsigned.
