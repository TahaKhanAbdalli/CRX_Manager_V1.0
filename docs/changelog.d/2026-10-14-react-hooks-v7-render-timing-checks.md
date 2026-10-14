## 2026-10-14 — React 19 follow-up: React's v7 hook checks now enforced (render-timing bugs)

**Why:** the React 19 upgrade (#906) exposed four real bugs, all from code that relied on React
drawing an in-between screen before the final one. React's own lint plugin, v7 (the project was on a
2024 release candidate), flags that whole class. A run over `src/` found 44 hits in the high-signal rules
plus ~230 in two noisier ones.

**What changed:**
- `eslint-plugin-react-hooks` `^5.1.0-rc` → `^7.1.1`. Because `npm run lint` uses `--max-warnings=0`,
  the rules are enforced, not advisory. `react-hooks/refs`, `purity`, `immutability`, `use-memo` and the
  rest of the v7 recommended set are ON. Two are OFF with a reason in `eslint.config.js`:
  `set-state-in-effect` (~200 ordinary "load data in an effect, then set state" screens; a separate,
  gradual cleanup) and `preserve-manual-memoization` (only matters once the React Compiler is adopted).
- Real fixes (screen state now drives what renders, instead of a value stored in a ref that does not
  re-render):
  - `FieldSetup`: the map's "remove the only part" control reads a `hasSavedBoundary` state mirror, not
    `loadedHadBoundaryRef` during render.
  - `BulkPOImport`: "Previously imported" badges read a `pendingIntentsView` state copy, published after
    the profile load and at the end of `handleImport`.
  - `Modal`: title id from `useId()` instead of `Math.random()` held in a ref.
- Zero-behavior reorders (a function or `useState` used before its declaration, harmless at runtime but
  flagged): `BulkFieldImport`, `BulkPOImport`, `TeamBoardFilters`, `TodaysDeliveries`, `useOCRProcessor`,
  `Rebates`, `SettingsPage`, `TeamBoard`, `Jobs`, `QuoteBuilder`; `LabelDataQuality` `useMemo` takes an
  inline function.
- Latest-value/latest-callback refs (`useRealtimeSubscription`, `useFormDraft`, `DrawControl`,
  `CustomerDetail`, `ProductDetail`, the fingerprint callback in `useUncertainMutationIntent`) now go
  through the new `src/hooks/useLatestRef.ts`, which writes the ref in a layout effect, so listeners and
  handlers only ever see committed values (CodeRabbit, PR #912). `DrawControl`'s `drawRef` is published
  in a layout effect too.
- Jobs: "Clear All" is no longer disabled when "Needs Dispatch only" is the only active filter
  (pre-existing; CodeRabbit, PR #912).
- Reviewed and kept, each with an inline reason: the one-time `tabIdRef` initialization in
  `useUncertainMutationIntent`; the
  `FieldApplicationInvoice` route gate; display-only clock reads (`CustomerContacts`, `CustomerFacts`,
  `UnbilledApplicationsPanel`); a clock read inside a `QuoteBuilder` handler; and `isRetryExpired` in the
  anti-double-charge hook, whose expiry timer re-renders exactly when the retry window closes.
- No live bug was found: each risky-looking site was correct today, but two (FieldSetup, BulkPOImport) were
  correct only because an unrelated state update happened to re-render.

**Proof:** `npm run lint` and `npm run typecheck` clean; full `vitest` 5,571 passed (one known full-suite
flake, `SupplierPricing.test.tsx`, passed 21/21 twice in isolation). New tests in
`BulkPOImport.test.tsx` and `FieldSetup.fieldObstacles.test.tsx` (load path and save path) pin the new
state wiring: each fails when its new `setState` publish is deleted. They do not reproduce a live
regression, because the old ref reads were also re-rendered by an unrelated state update. The badge
render copy clones each marker, so the in-place marker mutations in `bulkPOImportRetry.ts` never touch
React state. A local
click-through against live data (view only) loaded Team Board, Jobs (Clear All resets "Needs Dispatch
only"), Rebates, Settings, Label Data Quality, a quote, Purchase Orders and Fields with no console errors.
Modal titles resolve through `aria-labelledby`. The field-setup map HUD cannot render locally without a
Mapbox token; the unit test covers that prop.
