## 2026-10-27 — Stale-cost report review fixes (To-Do 0.7, CodeRabbit on PR #1133)

- Reports > Stale Costs: a page of products answered with no list is now a failure (error banner, export blocked), not an empty "no stale costs" report, matching the profitability report.
- A cost's "as of" date is now assembled from the year, month and day parts in Central time, as today's business date already is, instead of relying on the en-CA locale's layout.
