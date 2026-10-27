## 2026-10-27 — Price sheet: a retried apply replays its approval (To-Do 0.1, Codex App on PR #1131)

- Products and Product Detail now keep the approval key until the apply is confirmed. Before, the approval key was cleared as soon as approval succeeded. If the apply then committed but its answer was lost, the retry asked for a fresh approval, `approve_pricing_change_set` refused it with `CHANGE_SET_ALREADY_APPLIED`, and the screen kept showing a failure and old prices. Now the retry replays the stored approval (the database checks the key before the applied status) and then replays the apply.
- New test in `src/pages/Products.pricing-flow.test.tsx`: a lost apply answer retries with the same approval and apply keys. It fails on the previous code.
