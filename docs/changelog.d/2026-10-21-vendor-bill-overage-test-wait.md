## 2026-10-21 — vendor-bill overage test waits long enough under load

- `src/pages/NewVendorBill.overage.test.tsx` failed once during a loaded full-suite run (its reason
  prompt took 1067 ms against the 1 s default wait) and passed on its own. It now waits up to 5 s,
  the same setting `BatchAdjustModal.retry.test.tsx` uses for the same IndexedDB coordination.
  Test-only; no app behaviour changes.
