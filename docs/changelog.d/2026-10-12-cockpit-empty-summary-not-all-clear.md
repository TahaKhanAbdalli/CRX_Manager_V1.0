## 2026-10-12 - Office Cockpit: an empty summary answer no longer shows "All clear!"

PR #889, Codex P2. If the morning summary or program-completion query came back with no data and no
error (a silent permission denial), the page could still show the page-wide all-clear. Both answers
are now always validated, an empty one counts as a failed load, and the all-clear also requires the
morning summary to have loaded.
