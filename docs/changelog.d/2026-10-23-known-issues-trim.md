## 2026-10-23 — KNOWN_ISSUES.md trimmed to a short list of what is actually open

Goal 9 (handoff to an outside developer). `docs/manual/KNOWN_ISSUES.md` went from about 7,000 lines to a grouped
list of open, partly open, accepted and unverified items, each with severity, area, owner and a plain-English
paragraph. The whole previous file is preserved unchanged at
`docs/manual/archive/KNOWN_ISSUES-history-2026-10.md` (kept under `docs/manual/` so the PR stays
documentation-only); old section references (§0d, §4b, F06 and so on) resolve there.

Each open entry was checked by reading current `main` (code, migration files, merged PRs) at `62ca3b640`.
Six items were confirmed fixed with a PR or migration cited (listed at the bottom of the new file). Nothing
was marked fixed on a document's say-so alone. Not verified: any live-database fact (no database access in this
pass); those are labelled as the older record's claim or UNVERIFIED. No code, migration or hook changed.
