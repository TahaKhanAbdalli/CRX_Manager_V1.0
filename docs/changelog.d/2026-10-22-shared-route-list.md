## 2026-10-22 — one shared page list for the router, the permission list and the sidebar

- Every signed-in page is now one entry in `src/appPages.tsx`: its lazy-loaded component, its routes, the roles that
  may open it, and its Settings label and group. `src/App.tsx` builds the router from it, `PAGE_PERMISSIONS` and
  `EXEMPT_ROUTE_SEGMENTS` in `src/lib/pagePermissions.ts` are derived from it, and the sidebar takes each link's role
  gate from it. A sidebar link to an address that is not a page in the list fails `npm run typecheck`, and so does
  a page with a Settings label but no group (or the reverse), which would otherwise silently escape the deny list. The sidebar
  keeps its own order, wording and icons, which differ by role on purpose.
- One exception: the Field Invoices page's two field-application editor routes (`invoices/field-app/new` and
  `invoices/field-app/:id`) are still written out in `src/App.tsx`, because `src/pages/FieldApplicationInvoice.test.tsx`
  pins their text there and changing that money-file test would need a CodeRabbit review. `pagePermissions.test.ts`
  fails if any other route is hand-written in `App.tsx` or if those two stop matching the page's roles. Moving them is
  on the To-Do List for the next money PR that touches that test.
- No page's address, who can open it, or the sidebar's order or labels changed. `src/routeBaseline.test.tsx` proves
  it: its recording, `src/routeBaseline.json`, was taken from the unchanged code in a separate first commit, and the
  rebuilt code matches it for every route, all four roles, each page's deny-list entry, and every role's sidebar
  (with each page denied in turn, and with the split-billing flag on).
- `pagePermissions.test.ts` now walks the shared list instead of searching `App.tsx` text, and fails if a route's
  address does not resolve to its own page's permission key.
- `scripts/check-doc-drift.mjs` counts lazy pages in both files, and `scripts/generate-workflow-map.mjs` reads routes
  and roles from the shared list. The regenerated `docs/app-workflow-map.html` has the same routes, links and issues;
  Dashboard now shows as office-only (accurate: drivers and applicators were already sent away from it).
- `new-page` skill, `UI_PATTERNS.md`, `ARCHITECTURE.md`, `pages-routes.md`, `qa-testing.md` and `gotchas.md` describe
  adding a page the new way; the To-Do List's "One shared route list" item is replaced by the two-route follow-up.
- Tests that pinned route text in `App.tsx` (`JobDetailRoute.test.tsx`, `gauntletSections26Remediation.test.ts`) now
  read `src/appPages.tsx`; `CustomerDrawer.test.tsx` keeps the real router exports in its mock, because loading the
  page list builds its redirect routes.
