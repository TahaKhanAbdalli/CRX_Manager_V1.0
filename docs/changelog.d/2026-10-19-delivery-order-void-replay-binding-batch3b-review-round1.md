## 2026-10-19 — replay-binding batch 3b: review round 1 tightening (not yet applied)

The security and drift reviews of migration `20261019235000` found no blocker, high or medium issue.
From their low notes, the file now also pins the `search_path` of the three renamed bodies and of
`void_order`'s inner body (`_void_order_impl_20260714`) in its before and after checks, re-checks that
inner body's single version, owner and definer setting after the change, and its header no longer
claims the offline queue always sends a key for a cancelled delivery (no screen queues one today).
The real-schema prover still passes. Read-only live checks found no scheduled job and no function in
any schema that calls the three functions.
