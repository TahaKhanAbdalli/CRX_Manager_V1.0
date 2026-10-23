## 2026-10-21 — Goal 5 follow-ups: the server requires completion evidence; drivers' receipts for hidden customers

Migration `20261022075000_delivery_completion_evidence` (NOT YET APPLIED; ships with its PR, on Mason's
owner approval because it adds storage policies). Plan reviewed twice by Codex Sol (advisory) before the build.

- **Completion needs saved proof.** Every completion now tells the server how the customer confirmed it:
  an on-screen signature, a signed paper ticket, or (field stop, "No one present — left at site") a
  photo of where the delivery was left. `complete_delivery` and `start_and_complete_delivery` take
  `p_evidence` and `p_evidence_ref` and refuse, changing nothing (status, stock, invoices), unless that
  exact proof is saved: the signature image this attempt uploaded (its path is derived from the retry key
  and it must be owned by the caller), or the named ticket or drop-location photo of this delivery, with
  the right caption, stored in the delivery's own folder. The path and the reference are recorded in the
  new `deliveries.completion_evidence` and `completion_evidence_ref`; on the signature path the server sets
  `signature_url` itself. A trigger refuses any other way of marking a delivery completed and freezes the
  proof, the signer and the signature once it is completed.
- **Signature saved before the completion.** The delivery page, the field stop and the Deliveries list
  upload the signature image first, to a path unique to that attempt. If that upload fails, the page still
  sends the completion under the same key (after a lost reply it may replay an earlier commit); otherwise
  the server refuses it with `SIGNATURE_IMAGE_MISSING` and nothing changes, and the page says so. Two new storage rules let the delivery's people add and read those images while it is
  scheduled or in progress; there is no rule to replace or delete them. The four older signature rules
  are unchanged.
- **Old app versions.** An exact retry from the old app (no evidence) still replays a completion that was
  already saved; any new completion from it is refused with a message to reload the app.
- **Paper ticket everywhere.** The Deliveries list's Mark Delivered box and the delivery page's office
  layout gained "Customer signed a paper ticket" with a required photo, so office staff recording a
  delivery from a signed ticket never draw a signature themselves. An on-screen signature is now
  required on the other path (it was optional on the office layout and absent from the list). A
  completed delivery shows how it was confirmed.
- **Left at site needs a photo.** The field stop's "No one present" option now requires a photo of the
  drop location (confirmed by Mason on 2026-10-21).
- **Admin-only "Record without proof" (Mason, 2026-10-21).** On the Deliveries list and the office
  delivery page, an active admin can complete a delivery with no signature or photo by writing a reason
  (10–500 characters). The server refuses anyone else, records the reason, the admin and the time, sets
  the signer to "No proof — recorded by office", sends no customer receipt, and the delivery shows an
  amber "Recorded without proof" card (and a "No proof" label in the list). Planned with two Codex Sol
  advisory reviews.
- **Accepted proof cannot be changed later.** The recorded evidence freezes once written. An accepted
  ticket or drop-location photo row cannot be edited or deleted, and restrictive storage rules stop
  anyone replacing or deleting an accepted signature or photo file. The server refuses empty files and
  signature files that are not PNG images, and only a completion may set who signed.
- **Lost-reply retries.** If a completion went through but the phone never heard back, tapping Complete
  again now asks the server, which replays the completion instead of the screen wrongly saying it failed.
- **Driver receipts for hidden customers.** New read-only `get_delivery_receipt_recipient` gives an
  assigned driver the receipt email of a customer they cannot see (a stop scheduled before yesterday),
  while the delivery is open; the delivery page and the field stop use it (KNOWN_ISSUES, fixed entry).
- **Deferred:** a guaranteed retry of a receipt email that fails after the completion; the server-side
  queue design is written down in `docs/manual/KNOWN_ISSUES.md`.
- **Proof.** Browser preview of the real pages against a local test database (no live data): delivery
  page as a driver with an on-screen signature (hidden customer; receipt address read through the new
  function), field stop with a paper ticket and with "left at site", Deliveries list with a signature
  and with a paper ticket, office layout with a paper ticket; each recorded its path and reference,
  moved stock and drew one draft invoice. Refusals: a failed signature upload still sends the
  completion, which the server refuses (`SIGNATURE_IMAGE_MISSING`) with nothing changed
  (`DeliveryDetail.completion.test.tsx`); a server refusal (ticket file removed behind the screen's back) showed "The delivery
  was not completed (no stock or invoice change)…" with the delivery still In Progress, no stock moved
  and no invoice. Chain `smoke-delivery-completion-evidence.sql` (steps a–h) and container prover
  `scripts/smoke/prove-delivery-completion-evidence-real-schema.mjs` (old-app completions made before
  the apply replay after it; each server check removed in turn makes the chain fail). Not yet tried on a
  real phone.
