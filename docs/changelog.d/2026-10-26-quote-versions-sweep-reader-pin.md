## 2026-10-26 — quote-versions sweep pins the snapshot reader and the read policy (review round 2)

- New `get_quote_versions:contract-pinned` branch makes the one-time `COST_LOCK_PREFLIGHT` check in
  `20261022101000` standing: `get_quote_versions(uuid)` must keep its reviewed body digest
  (`md5(replace(prosrc, chr(13), ''))` = `8f0592c4877da51eb5b9074b775ed0cc`), SECURITY DEFINER, owner
  `postgres` and `search_path=public, pg_temp`. A reviewed re-emission must update this pin.
- `quote_versions:read-path-regressed` now pins the `qversions_select` row condition by digest
  (`466a3791a1874c9cba20ac690f330c7b`) and accepts a policy aimed at any role `authenticated` belongs to.
- Live read-only check 2026-10-26: neither branch fires.
