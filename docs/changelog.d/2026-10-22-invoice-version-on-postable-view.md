## 2026-10-22 — the invoice posting version moves onto a view without cost columns

**What changed.** Migration `20261022090000_invoices_postable_view` (migration history row 976; written, not yet
applied) adds `invoices_postable`, a read-only view of every invoice column except the cost total, which applies the
caller's own access rules, and puts the posting version (PR #1018) on it as `invoice_postable_version`: its own name,
not a second `invoice_post_version`, so a caller can never reach the wrong one. The seven screens that
post invoices (invoice detail, the invoice list, field-application invoices, the split editor, order detail, the office
cockpit and the unposted field-invoice panel) read the version from the view, in the same read as the rows they show,
named back to `invoice_post_version` so the rest of the app is unchanged.
Nothing about what posting checks changes.

**Why.** The version is a computed field, which receives a whole row, and the database only allows that when the caller
can read every column. The cost column lock (`20261022101000`, restamped from `20261022091000`; Goal 1 step 3) takes the invoice cost column away from
the app's accounts, after which reading the version from `invoices` fails for everyone and invoices could be neither
opened nor posted. The view's row has no cost column, so the version keeps working. This PR lands first; the lock then
drops the old version function.

**Guards.** `src/lib/costFields.test.ts` fails if a `.from(...).select(...)` chain in `src/` selects the version from
anything but the view (it reads literal and same-file constant select strings; queries built across statements or
from imported constants are not traced), if the view's columns drift from the invoice table's columns minus cost, and
if a later migration changes an invoice column without re-creating the view. A live rollback-only smoke chain
(`smoke-invoices-postable-view.sql`) checks the view and the new function after the apply.

**Proof.** `node scripts/smoke/prove-post-binds-reviewed-invoice-version-real-schema.mjs` replays PR #1018's whole posting
matrix with every version read from the view, checks the view's rules, then simulates the cost lock and replays the
matrix again. A throwaway PostgREST v14.16 run showed the screens' embedded reads, named links, paging and filters work
through the view, and that writes and signed-out reads are refused.
