## 2026-10-26 — quote-versions sweep: tighter read-path and anon checks (review round 1)

- Codex (Luna) review of the column-read fix found the new checks too loose: one granted column would
  satisfy them, the policy's role and the snapshot reader's SECURITY DEFINER mode were unchecked, and anon
  reads were watched only on `snapshot_data`.
- `quote_versions:read-path-regressed` now checks each of the nine history columns, that
  `qversions_select` is permissive and applies to `authenticated`, and that `get_quote_versions(uuid)` stays
  SECURITY DEFINER. New `quote_versions:anon-read` fires if `anon` can read any column or call
  `get_quote_versions(uuid)`. All return no rows on live (read-only check, 2026-10-26).
