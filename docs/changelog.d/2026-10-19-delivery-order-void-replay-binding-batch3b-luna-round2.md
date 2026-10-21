## 2026-10-19 — replay-binding batch 3b: Codex Luna round 2 fixes (not yet applied)

Luna round 2 found no blocker or high issue; its three findings are fixed:

- **MED:** before taking the server role's access away from `void_order`'s inner body
  (`_void_order_impl_20260714`), the migration now checks that no other function in any schema
  calls it (a read-only live check found none, and no scheduled job).
- **LOW:** the smoke chain now proves the role check on the case it exists for: the person who
  wrote a cancel receipt, after losing the role, retries the exact same request and is refused with
  "Not authorized to cancel deliveries" instead of being handed the saved result. With the wrapper's
  role check taken out, the prover shows the chain fails at that step.
- **LOW:** the prover's check of the inner body now compares it with the pinned live body plus only
  the one zeroing edit, instead of comparing a value with itself.
- The dynamic statement that installs the draft-cancel fix passes the function name as an argument,
  so the repository's migration scanners do not mistake it for a function definition.
