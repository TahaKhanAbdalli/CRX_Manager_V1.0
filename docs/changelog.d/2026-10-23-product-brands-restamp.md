## 2026-10-23 — Product brands migration renumbered to 20261022085000 (step 1, PR A)

**What changed.** The CRX Coordinator changed the landing order twice on 2026-10-23. It first moved swap A (#1057, `20261022090000`) ahead of PR #1050, then put #1050 first again when swap A was not ready. The not-yet-applied product brands migration moves from `20261022080000` to `20261022085000`, by way of a brief `20261022090500`. It now applies right after #1024 (`20261022075000`, the newest live stamp) and before swap A. Its SQL is unchanged. Only the file name, its header comment, and every reference carry the new number: migration history row 975, the reference docs, the smoke chain and its Docker proof, `src/lib/db.ts`, and the live-function snapshot note.

**Proof.** No reference to an earlier number remains. The documentation check, type check and the affected tests pass, and `node scripts/smoke/prove-product-brands.mjs` passes against the renamed file.
