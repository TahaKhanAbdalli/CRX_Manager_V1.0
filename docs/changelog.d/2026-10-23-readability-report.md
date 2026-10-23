## 2026-10-23 - readability report for the developer handoff

Added `docs/audits/2026-10-23-readability-report.md`. It ranks the 10 places in CRX Manager a new
senior developer will find hardest to follow, gives the risk and a suggested simplification for
each, and lists safe quick wins plus the patterns to keep. It also records four defects found
while reading, none of them fixed here:

- the delivery receipt email does not escape its HTML;
- the invoice product search breaks on names with commas;
- the invoice PDF ignores a failed line-item read;
- editing a delivery may carry over to the next delivery opened.

The work was read-only and changed no code. Mason chose not to simplify broadly before the
2027-01-01 cutover; the report is a map for choosing what to simplify after the January pilot.
