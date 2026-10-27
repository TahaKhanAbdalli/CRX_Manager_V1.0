## 2026-10-26 - Sol may go first only before ANY CodeRabbit review (#1125, Codex App P2)

When a merge of main voids an earlier CodeRabbit review, `readCodeRabbitRequirement()` now still
reports `priorReview: true`, and the Sol pre-flight lets Sol run before CodeRabbit only on an
explicit "no review yet" (`priorReview === false`). Before, that case read as "never reviewed" and
let Sol run first, so the new review's fixes would void a paid Sol proof.
