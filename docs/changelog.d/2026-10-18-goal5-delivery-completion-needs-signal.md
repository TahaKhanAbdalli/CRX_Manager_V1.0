## 2026-10-18 — Goal 5: completing a delivery needs a signal, with a paper-ticket fallback

Mason decided on 2026-10-15 that a delivery is completed only with a connection. This change makes
every delivery completion path follow that rule. It is an app-only change: no migration, and
`complete_delivery` is untouched.

- **New `src/lib/connectivity.ts`.** `hasSignal()` checks the phone's offline flag and then makes one
  tiny database read, so farm Wi-Fi with no internet behind it also counts as no signal. Any HTTP
  answer counts as signal; a dropped request (no automatic retries) or one still unanswered after
  6 seconds does not.
- **Delivery page (`DeliveryDetail.tsx`) and field stop (`FieldStop.tsx`).** The "Save Offline" path is
  removed. Without signal, Complete shows "No signal. This delivery was NOT completed and nothing was
  saved…" and changes nothing. The offline notices now say a delivery can only be completed with
  signal.
- **Deliveries list (`Deliveries.tsx`).** Mark Delivered / Mark Complete checks for signal before the
  start step and again between start and complete. If signal drops between them, the driver is told
  the delivery is now In Progress but not completed, with no stock taken and nothing billed, and
  the table row shows it as In Progress right away (no reload is attempted without signal). The
  signal check takes a few seconds, so after each check the list confirms the dialog is still open
  for the same delivery (Cancel during a check sends nothing more), and the delivery page confirms
  the driver has not moved to another delivery, before the next server call. Each opening of the
  list dialog is its own session, so cancelling and reopening the same delivery during a check
  never lets the old request submit or close the new dialog. If the driver or office user edits a
  quantity, the signer, the drawn signature, the receipt choice, an issue note or the date while the
  signal check runs, the completion stops
  ("Details changed while checking for signal") instead of sending the values captured at confirm.
- **"Today" for completion dates is the Chicago business day.** The paper-ticket date (default,
  latest allowed, validation) and the Deliveries list's "Delivered on" use today in
  America/Chicago (`todayInBusinessTz`), the day the server dates the delivery, not the phone's
  own date. The completion time is worked out right before the server call, after the signal
  check, so a delivery dated "today" keeps that day even if midnight passes during the check. The
  remaining instant between the two server calls is recorded in `docs/manual/KNOWN_ISSUES.md`;
  Mason chose to ship with it and close it later with one combined server call.
- **Paper-ticket fallback (new `src/lib/paperTicket.ts`).** On the delivery page's driver layout and
  the field stop, "Customer signed a paper ticket (no signal at the site)" replaces the on-screen
  signature with a required photo of the signed ticket. The photo is an ordinary delivery photo
  captioned "Signed paper delivery ticket"; the signer's name is still required, no signature
  image is saved. The customer receipt email follows the same "email a receipt" choice as an
  on-screen signature (the customer keeps the signed paper ticket); a guaranteed receipt needs a
  server-side receipt queue, recorded as open.
  The driver also enters the "Delivered on" date from the ticket (today by default, never in the
  future); a past date is sent as the completion time, so the delivery and its invoice land on the
  day the delivery really happened, not the day it was entered. The date is required (an empty
  date blocks completion), and the customer receipt shows that same date.
  A past date is sent as 17:00 UTC (midday in Chicago), so the server's America/Chicago date is the
  chosen date whatever time zone the phone is set to; the Deliveries list's backdate uses the same
  helper (`completedAtForDeliveredOn`).
  The Deliveries list dialog (office staff only) says the assigned driver completes a paper-ticket
  delivery from their own delivery screen, since only the driver layout has the ticket controls. The ticket photo
  is required only when the driver ticks the paper-ticket box, and that check is in the app only:
  `complete_delivery` requires no completion evidence on either path (an on-screen signature is not
  server-required either), so a server-enforced link to the ticket photo is recorded as open. Ticket photos do not count toward
  the 10-photo limit (they have their own limit of 2), and on the field stop a saved ticket photo
  stays on screen even if the photo list fails to reload. Moving to another stop clears the photo
  list first, so one stop's ticket photo can never satisfy the next stop's check.
- **Photo upload no longer resets edited quantities.** On the delivery page, a photo upload used to
  reload the whole delivery, putting short quantities back to full. It now refreshes only the
  photos, so taking the ticket photo after marking items short can't record a full delivery.
- **A failed receipt email is no longer silent.** If the customer receipt email cannot be sent after
  a delivery completes (for example, signal drops in between), the delivery page and the field stop
  now tell the driver and point to the office's Email Confirmation button. A guaranteed retry needs
  a server-side email queue and is recorded as open in the Goal 5 plan.
- **An edited retry can no longer reuse an earlier attempt's result.** The server's retry check
  matches only the retry key, not what was sent. If a completion was saved but its reply was lost,
  a retry after the driver changed the ticket date, signer or quantities used to get the first
  result back while the receipt showed the new values. On the delivery page and the field stop the
  key is now tied to the exact inputs (`fingerprintIntentPayload`): the same inputs reuse the key
  and get the saved result back; changed inputs get a fresh key, which the server refuses because
  the delivery is already completed, so no receipt with the wrong date is sent. The key is also
  retired only after the server's reply checks out. Proven in the preview with a test server that
  saved the completion and dropped its replies (Sol final review). The Deliveries list dialog binds
  its key the same way (signer and date), so an edited retry there is refused the same way (Luna
  review). The key uses the date the driver picked, not the completion time worked out from it,
  so an exact retry that crosses midnight (when "today" becomes yesterday) keeps its key and gets
  the saved result back.
- **A paper-ticket receipt is never skipped silently.** If the phone has no customer email for a
  paper-ticket delivery (none on file, or the customer record is hidden from that driver by the
  current `customers_select` policy), the driver is told no receipt was sent from the phone and
  that the office can send it. Reading the recipient through the server is recorded as open in
  `docs/manual/KNOWN_ISSUES.md`.
- **The Deliveries list requires its "Delivered on" date.** An emptied date used to complete the
  delivery dated today; it is now refused before anything is sent. One shared check
  (`isValidDeliveredOn`) also refuses dates that do not exist, such as 2026-02-31, on the list and
  on both paper-ticket screens.
- **Pre-existing race fixed: a slow load can no longer leak onto the next delivery.** The delivery
  page is reused when moving from one delivery to another. A slow load for the previous delivery used
  to finish late and put its items, quantities and photos on the new delivery's screen, so the wrong
  quantities (or the wrong ticket photo) could be submitted for it. Every step of the load now checks
  it still belongs to the delivery on screen. Reproduced in the preview by delaying one delivery's
  item load (the next delivery showed 5 instead of its own 3); with the fix it keeps its own 3.
  Moving to another delivery also clears the previous one's items, quantities, signer, signature,
  issue and open confirm box before the screen redraws, and Complete refuses ("still loading")
  until the new delivery's own items have loaded, so it can never submit the previous delivery's
  quantities under the new delivery's id. The page also shows its loading spinner (no previous
  delivery, no action buttons) until the new delivery's record has loaded, so nothing (complete,
  cancel, void) can be done to the new delivery while the previous one's details are on screen.
- **Pre-existing bug fixed.** On the delivery page's driver layout, Complete Delivery opened a
  confirmation box that was never drawn, so a driver's tap did nothing. Both layouts now share it.
- **Not changed.** Completions already queued offline before this ships still sync, or go to Offline
  Work Review (`src/lib/offlineSync.ts` keeps its `complete_delivery` handler). Field-application job
  completion (`FieldView.tsx`, `complete_job`) still queues offline; Goal 5 covers deliveries only.

**Proof.** Browser preview of the real pages against a local test database (no live data), with
signal cut off in the page: on the delivery page (office and driver layouts), the field stop and the
Deliveries list, Complete was refused with the message above, the test server received no
`confirm_delivery` or `complete_delivery` call, the delivery's status was unchanged and the offline
queue stayed empty. Wi-Fi-without-internet was refused the same way. With signal back, each completed
with exactly one `complete_delivery` call. The list's signal-drop-between-steps case left the delivery
In Progress with only `confirm_delivery` received, then completed on retry. Supporting tests:
`src/lib/connectivity.test.ts`. Not yet tried on a real phone in airplane mode.
