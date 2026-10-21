## 2026-10-20 — replay-binding batch 3b: split-invoice void recorded as an open follow-up

- Codex's GitHub review found that voiding an order whose draft invoice came from the split feature
  still fails: the split-invoice guard lets that draft's total change only under a claim row that
  `cancel_order` writes and `void_order` does not. Checked against the live definitions: true, but
  not a regression (every nonzero draft already failed before batch 3b), and live has no split
  invoices at all. Recorded in `docs/manual/KNOWN_ISSUES.md` as an open follow-up, to be fixed in
  its own reviewed migration before split billing is used. The migration file is unchanged.
