## 2026-10-19 — replay-binding batch 3b: review round 3 wording fix (not yet applied)

- The migration-history row (956) and a prover comment still said the void-order draft-invoice fix
  was installed by text substitution. They now describe what the migration does since round 2: it
  writes out the full body (the md5-pinned live body plus only the four zeroing lines), and the
  postflight re-proves that equivalence (CodeRabbit).
