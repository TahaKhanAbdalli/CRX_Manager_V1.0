## 2026-10-23 — Create User activates the new user in one step

- The `create-user` Edge Function now finishes the job itself: right after it creates the login, it sets the
  chosen name, role and phone and activates the user (which lifts the login block from `handle_new_user`,
  migration `20261022023000`) through `admin_update_profile`. It calls that function with the requesting
  admin's own login, not the service-role key, so the database's active-admin check and profile guards still
  decide. Its idempotency key names the new user plus a random part (`create-user-activate:<user id>:<uuid>`),
  so no other call can use it up first and replay a cached success. The reply says
  `activated: true` or `activated: false` (the login then exists but stays blocked); the reason for a failure
  goes to Sentry only, never into the reply.
- Settings → Create User makes its own `admin_update_profile` call only when the reply is not
  `activated: true` (an older deployed function, or a failed activation), so the page and the function can go
  live in either order.
- Not changed: the database, Auth settings, existing users. A pending login found by email is still never
  adopted automatically.
- Proof: `deno test --node-modules-dir=none supabase/functions/create-user` (activation logic), a local run
  of the real function against recorded fake Auth/database replies (activation sent with the admin's token).
  Deployed as `create-user` v25 (ACTIVE; boots and answers the preflight, refuses a call with no login).
- Not yet verified: a live Create User through the Settings page on v25. Owed, and recorded when done.
