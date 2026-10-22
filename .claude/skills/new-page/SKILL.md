---
name: new-page
description: Scaffold a new page in CRX Manager with its lazy import and entry in the shared page list (which drives the route and the permission registry), sidebar nav link, and documentation updates. Use when the user wants to add a new page or screen to the app.
---

# Add New Page

Scaffold a complete new page with all the wiring CRX Manager requires — component file,
lazy import, **one entry in the shared page list `src/appPages.tsx`** (the router and the
permission registry both read it), sidebar nav link, and doc updates.

The page entry is not optional: `ProtectedRoute` is **fail-closed**. A route with no
permission entry is redirected away. Because the router and `PAGE_PERMISSIONS` are both
built from the same entry, they cannot disagree.

## Step 1: Gather Requirements

Ask the user (skip if they already described it):
- **Page name** — What should the page be called? (e.g., "Tote Tracking")
- **Route path** — What URL path? (e.g., `/tote-tracking`)
- **Nav category** — Which sidebar group? Read the category list in
  `src/components/layout/Sidebar.tsx` and offer the real ones rather than guessing.
- **Role access** — Who can see it? (`admin`, `sales_rep`, `applicator`, `driver`)
- **Purpose** — One sentence about what the page does

## Step 2: Create the Page Component

Create `src/pages/<PageName>.tsx`. Start minimal and import only what the page actually
uses — unused imports fail `npm run lint`:

```tsx
export default function PageName() {
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">Page Title</h1>
      </div>

      <div className="bg-white rounded-lg shadow p-6">
        <p className="text-gray-500">Page content goes here.</p>
      </div>
    </div>
  );
}
```

Add `useState`/`useEffect`, `supabase`/`checkMutationResult` from `../lib/db`, or `useAuth`
from `../contexts/AuthContext` **only when the page uses them**.

Key rules:
- Use Tailwind CSS only (brand color: `crx-green` / `#28A26A`)
- Lucide React icons only
- Export as `default` function (required for lazy loading)
- `src/lib/db.ts` is the only Supabase client; call `assertRpcResult()` after RPCs and
  `checkMutationResult()` after `.update()` / `.delete()`

## Step 3: Wire Up the Route

Every signed-in page lives in **one shared list, `src/appPages.tsx`**. The router
(`App.tsx`) builds its routes from it, the permission registry (`PAGE_PERMISSIONS` in
`src/lib/pagePermissions.ts`) is derived from it, and the sidebar takes each link's role
gate from it. Do **not** add routes to `App.tsx` or entries to `PAGE_PERMISSIONS` by hand.

### 3a. Add the lazy import to `src/appPages.tsx`

Find the lazy import block and add:

```typescript
const PageName = lazy(() => import('./pages/PageName'));
// Only if the page has a separate detail screen:
const PageNameDetail = lazy(() => import('./pages/PageNameDetail'));
```

### 3b. Add the page entry to `APP_PAGES` (REQUIRED)

Add one entry, under the matching category comment. The entry's position is the order the
Settings permission screen and the command palette show it in:

```tsx
{
  key: 'route-path', label: 'Page Title', category: 'Sell & Deliver', roles: ['admin', 'sales_rep'],
  routes: [
    { path: 'route-path', element: <PageName /> },
    { path: 'route-path/:id', element: <PageNameDetail /> },
  ],
},
```

- `key` is the permission and deny-list key, and must be the first segment of the address.
- `roles` is who may open it; the router wraps every route in `ProtectedRoute` with it.
- `label` and `category` name and group it on the Settings permission screen and in the
  command palette. Leave both out only for a page every listed role always sees and that can
  never be denied (like Team Board); it is then exempt from the deny list.
- `routes` paths are relative (no leading slash). The **first** route is the page's own
  address, where Settings, the command palette and the sidebar link. A route that fewer roles
  may open sets its own `roles` (see `deliveries/new`).
- Suspense is centralized in `RouteShell`. **Do not add a per-route `<Suspense>` wrapper.**

`src/lib/pagePermissions.test.ts` fails if a route's address does not map to its page's key.

### 3c. Add the sidebar nav link

Navigation lives in `src/components/layout/Sidebar.tsx` (there is **no**
`src/components/AppLayout.tsx` nav list). Each role has its own tree —
`officeNavigation`, `applicatorNavigation`, `driverNavigation`, selected by
`getNavigationForRole`. Add the item to the correct category's `items` array:

```tsx
{ path: '/route-path', label: 'Page Title', icon: <IconName className="w-4 h-4" /> },
```

`path` must be a page's own address from `src/appPages.tsx` — anything else fails
`npm run typecheck`. Which roles see the link comes from that page's `roles`; there is no
`roles` field on sidebar items. The sidebar label may differ from the Settings label.
Use `w-4 h-4` for category sub-items and `w-5 h-5` for standalone top-level links, matching
the surrounding entries. Choose a Lucide icon that matches the page's purpose.

### 3d. Update the route baseline

`src/routeBaseline.test.tsx` records, for every route and role, who can open it, and every
role's sidebar. A new page changes that recording on purpose, so re-record it:

```bash
UPDATE_ROUTE_BASELINE=1 npx vitest run src/routeBaseline.test.tsx
```

Then read the diff of `src/routeBaseline.json`: it must show only the new page's own rows — its
routes, its sidebar link, and (for a page with a Settings label) its entry in `permissions.pages`
plus its key in `permissions.byRole` for each role that may open it. Nothing about any other page
may change. Say in the PR which rows changed and why.

## Step 4: Update Documentation

### pages-routes.md
Read `docs/reference/pages-routes.md` and add a new row:

| Route | Page Component | Description | Access |
|-------|---------------|-------------|--------|
| /route-path | PageName | One-line description | Role info |

**Do not put page counts in `CLAUDE.md` or `AGENTS.md`.** Volatile counts belong in
`docs/reference/`, and `npm run check:agent-guidance` fails when they appear in the
always-loaded agent files. If a total is stated in `docs/reference/pages-routes.md`,
update it there.

## Step 5: Verify

```bash
npm run lint && npm run typecheck && npm run test -- src/lib/pagePermissions.test.ts src/routeBaseline.test.tsx && npm run build
```

Then actually open the page — done means the changed behavior ran and was observed:
start the dev preview, navigate to the new route, confirm it renders, the sidebar link
appears for an allowed role, and the console is clean. Check the phone width too if the
page is field-facing. Fix any errors before reporting done.

## Step 6: Print Summary

```
=== New Page Created ===

Component: src/pages/PageName.tsx
Page entry: src/appPages.tsx 'route-path' (roles: ..., Settings: [category] / [label])
Routes:    /route-path, ... (App.tsx builds them; RouteShell handles suspense)
Nav:       Sidebar.tsx → [category] in [officeNavigation|applicatorNavigation|driverNavigation]
Icon:      [IconName] from lucide-react

Docs updated:
  - docs/reference/pages-routes.md (new entry)
  - src/routeBaseline.json (re-recorded; only the new page's rows changed)

Lint: PASS
Typecheck: PASS
pagePermissions + routeBaseline tests: PASS
Build: PASS
Rendered: /route-path opened, renders, console clean
```

## Safety Rules

- NEVER skip the lazy import — all pages must be lazy-loaded
- NEVER add a route to `App.tsx` or an entry to `PAGE_PERMISSIONS` by hand — add the page
  to `src/appPages.tsx`, which both read
- NEVER re-record `src/routeBaseline.json` without reading its diff — it is the proof that
  nobody else's access changed
- NEVER skip the nav link — pages must be discoverable
- NEVER add a per-route `<Suspense>`; `RouteShell` already provides it
- NEVER add a page/route count to `CLAUDE.md` or `AGENTS.md`
- NEVER use icons from outside lucide-react
- NEVER use CSS frameworks other than Tailwind
- NEVER commit automatically — the user decides when
