## 2026-10-23 - native patch: the local-disk assumption is written down

Luna review round 11 on the native `apply_patch` route again raised that one synchronous filesystem
lookup cannot be interrupted by the hook deadline. That is true of any synchronous lookup and cannot be
closed from inside a pre-tool hook; destinations are now confined to the repository before any lookup, so
the exposure is a repository that itself sits on a slow network share. `docs/reference/agent-guardrails.md`
now states that the repository is assumed to be on a local disk.
