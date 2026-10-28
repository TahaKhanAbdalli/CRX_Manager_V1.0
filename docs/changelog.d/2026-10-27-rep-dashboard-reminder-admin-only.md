## 2026-10-27 — Only an admin's dashboard load runs the remainder reminders (Sentry CRX-MANAGER-1C)

- `check_remainder_reminders` raises `INSUFFICIENT_ROLE` for anyone but an admin, so every sales rep dashboard load sent a Sentry error and logged a failed notification. The dashboard now calls it only for admins; the nightly `check-remainder-reminders` cron (daily 06:30 UTC) still sends the reminders for everyone.
- New test `src/pages/Dashboard.reminders.test.tsx` (fails on the old code for a rep load).
