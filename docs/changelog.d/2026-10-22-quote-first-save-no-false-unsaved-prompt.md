## 2026-10-22 — Quotes: the first Save Draft no longer shows a false "Unsaved Changes" prompt

- Seen live during PR #1038's click-through: saving a NEW quote as a draft showed "Quote saved as draft" and then the
  "Unsaved Changes — Leave / Stay" dialog as the page moved to the saved quote. A rep who chose Stay was left on
  `/quotes/new` holding a quote that was already saved.
- Cause: `handleSaveDraft` cleared the dirty flag and navigated in the same tick, so the router's blocker still held the
  old "dirty" value. Same bug class as the field-application invoice screen (2026-10-09), fixed the same way:
  `QuoteBuilder` now passes a one-shot skip ref to `useUnsavedChanges` and sets it right before each navigation that
  follows a committed write — first Save Draft, booking draw-down to an order, Convert to an order, and Convert's
  "order already created" recovery. A real unsaved edit still prompts.
- The quote form (template picker, details, Planned Program, sections, footer notes) is now locked while Save Draft,
  Convert or a booking draw-down runs, and the draw-down quantities are locked while that order is created. An edit
  made during those few seconds would not be in what was written, and the page then moves on (Codex review, Luna and
  Sol on this PR).
- Ticking Planned Program now marks the quote as having unsaved changes; before, it was the one field that did not.
- New `src/pages/QuoteBuilder.saveNavigation.test.tsx` uses the real router, hook and dialog to cover both cases.
- Frontend only; the save payload, line ids and every RPC are unchanged.
