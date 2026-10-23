## 2026-10-22 — Pilot procedure drafts: which screens can complete a paper-ticket delivery

- `docs/plans/2026-10-22-pilot-launch-procedures-draft.md` now names the screens that have the
  paper-ticket option (the **Customer signed a paper ticket** checkbox, ticket photo and **Delivered on
  (date on the ticket)**): the driver layout of the delivery page, and **My Route**
  (`/my-route/:id`, `src/pages/FieldStop.tsx`), which admins, sales reps and drivers can all open
  (`src/appPages.tsx`). The office's normal delivery page (`src/pages/DeliveryDetail.tsx`, admin and
  sales-rep layout) has no paper-ticket option, so it would record a delivery as made at that moment.
  After a database restore, the person running the recovery completes the paper deliveries from **My
  Route** while CRX stays closed to staff.
- Follow-up to PR #1041. Two earlier heads of this PR were wrong in opposite directions ("admins can
  use Take Delivery", then "only drivers can"); the Codex GitHub App reviews led to this version,
  checked against the code. Documentation only.
