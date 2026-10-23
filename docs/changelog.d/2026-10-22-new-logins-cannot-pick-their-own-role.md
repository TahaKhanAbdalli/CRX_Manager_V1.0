## 2026-10-22 — a new login can no longer pick its own role

- Migration `20261022023000_handle_new_user_ignores_signup_role.sql` (migration-history row 969): the
  `handle_new_user` trigger no longer copies the role from signup metadata. Every user the Auth service creates
  (public signup, and the admin API behind the `create-user` Edge Function) starts as an inactive driver whose
  login is blocked and named `Pending user <id>` (a placeholder that cannot collide with a real name), whatever name and role it asked for. Before,
  re-enabling public signup in the Supabase dashboard would have let anyone sign up as an active admin; that
  dashboard setting was the only protection. Direct SQL as `postgres`/`supabase_admin` (seeds, provers) keeps the
  old behaviour, but not after a `SET ROLE` (a login that switches accounts gets the safe default).
- Settings → Create User now sets the chosen name and role and activates the user (which lifts the login block)
  right after the Edge Function returns, through `admin_update_profile`. If that second step fails (for example
  another user already has that name), the toast says the login exists but is blocked, and the admin finishes it
  from the user's Edit dialog.
- Not changed: the `create-user` Edge Function, Auth settings (public signup stays disabled), existing profiles.
- Proof: `node scripts/smoke/prove-handle-new-user-ignores-signup-role-real-schema.mjs` (Docker).
