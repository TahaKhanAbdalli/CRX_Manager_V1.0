## 2026-10-27 — Purchase order copy email is live (send-email v20, To-Do 0.15)

- The `send-email` Edge Function is deployed as v20 on Mason's approval, so admins can email a PO copy (PDF) to mason@croprxsolutions.com from a purchase order. It goes only to that address and never to a vendor, and it is refused if the PDF no longer matches the PO.
- Proven live: Email PO Copy on PO-2026-0024 sent one email, logged as `sent`, which arrived with its PDF. `docs/manual/CURRENT_STATE.md` records the deploy.
