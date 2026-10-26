## 2026-10-26 — Convert to Order gap recorded as also hitting December pre-bookings

Maksym reported that the Convert to Order gap (the quote is accepted, which frees its stock holds, before the
order is created) also affects the December pre-booking flow. The code confirms it. A pre-booking is a Planned
Program quote whose stock is held by `create_planned_holds`. Whole Convert to Order and Book as Order both save the
quote as Accepted first (`src/pages/QuoteBuilder.tsx:3447-3449`), and the trigger
`release_holds_on_quote_status_change` frees every active hold on that status change. Partial Order
(`draw_down_quote`) is a single database call and is not affected.

Documentation only. KI-12 in `docs/manual/KNOWN_ISSUES.md` now names the pre-booking case and the current line
numbers, and To-Do 1.3 in `docs/manual/TO_DO_LIST.md` now says the gap is still open and covers pre-bookings. No code
or database change.
