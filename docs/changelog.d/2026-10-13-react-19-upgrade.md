## 2026-10-13 — React 18 → React 19 (supersedes Dependabot #898)

Mason decided on 2026-10-13 to do React 19 as its own change, before the next major app work,
so new work is written once for React 19. ESLint 10 stays deferred (#897 closed;
eslint-plugin-jsx-a11y 6.10.2 does not support it yet).

| Package | From | To |
| --- | --- | --- |
| `react` | 18.3.1 | 19.3.0 |
| `react-dom` | 18.3.1 | 19.3.0 |
| `@types/react` (dev) | 18.3.x | 19.3.0 |
| `@types/react-dom` (dev) | 18.3.0 | 19.3.0 |

#898 proposed 19.2.7. `npm` resolves the same caret range to 19.3.0, published 2026-09-09, so the
manifest names the version that was actually tested.

**Library compatibility.** Every React-dependent package already declares React 19 in its peer range:
- `@testing-library/react` 16.3.3
- `react-router(-dom)` 7.18.4
- `react-map-gl` / `@vis.gl/react-mapbox` 8.1.3
- `lucide-react` 1.56.0
- `@sentry/react` 10.76.2
- `@fullcalendar/react` 6.1.21

A clean `npm ci` needs no `--force` or `--legacy-peer-deps`, and `npm ls` reports no invalid peers.

**React 19 breaking-change sweep.** The repo has none of these:
- `propTypes` or `defaultProps` on function components
- string refs
- legacy context
- `ReactDOM.render` / `hydrate` (it already uses `createRoot`)
- `findDOMNode`
- `react-dom/test-utils` (tests import `act` from Testing Library)
- `element.ref` access
- ref callbacks that return a value

**Type fixes.** The global `JSX` namespace is gone, so five sites import `type JSX` from `react`.
`useRef()` now requires an initial value, so three timer refs start at `null`.

**Behaviour fixes React 19's render timing exposed.** These showed up as test failures; each fix is
correct under any React version:
- `BatchAdjustModal`: the "saw a frozen batch" effect could run after the dialog had already resolved
  its own batch. It then labelled that batch "finished in another tab" and blocked further
  adjustments. The effect now ignores the dialog's own in-flight batch.
- `JobDetail`: the label-rate save gate used a boolean that stayed `true` from the empty product set
  for the render in which the job's lines arrived. A Save in that window passed the fail-closed gate.
  "Loaded" is now tied to the exact product-id set.
- `BlendTicketDetail`: dirty tracking re-armed on `requestAnimationFrame`, assuming hydration had
  rendered by then. Under React 19 the page could flag its own load as an edit, which disabled
  Approve/Reject. Renders that still show the exact hydrated objects are no longer counted as edits.

- `UnbilledApplicationsPanel`: after a "could not verify the invoice result" refusal, a fresh
  idempotency key came only from the loading spinner remounting each row action. React 19 can merge
  a fast loading true→false pair into one render, which skipped the remount and replayed the old key
  until a page reload. A successful reconciliation now bumps a generation that keys each row action,
  so the remount always happens. The test mocks still answer instantly; without the key, 7 of 12 fail.
- `BlendTicketDetail` (pre-existing, found in review): the OCR re-process path cleared dirty
  tracking before reloading. A failed reload therefore left later edits untracked, so a ticket could
  be approved or left with unsaved edits silently lost. `loadTicketData` already suspends and
  restores tracking itself. A new test fails with the old line and passes without it.

**Test-only timing fixes.**
- `SupplierPricing`: `findByText` replaces a synchronous assertion.
- `JobDetail` (discontinued product): the test now waits for the by-id lookup to settle. It still
  fails if the block never clears, which was mutation-checked by disabling the by-id form lookup.

**Proof observed** on this tree:
- `npm run typecheck`, `npm run lint`, `npm run build`, `npm run test:correction-guards` and
  `npm run test:agent-workflows` all passed.
- Full `npm test`: 391 files, all passed, 0 failed.
- `node scripts/verify-deps.mjs --force` passed, and `npm audit --audit-level=high` found 0 vulnerabilities.
- The same five failing test files passed 106/106 on `main` under React 18, which confirms React 19
  caused the failures.
- The dev-server login page ran on React 19.3.0 with no console warnings.

No migration.
