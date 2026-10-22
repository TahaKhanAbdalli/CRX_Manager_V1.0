/**
 * routeBaseline.test.tsx — proves who can open each page, and what each role's
 * sidebar shows, still match the recording in routeBaseline.json.
 *
 * Recorded 2026-10-22 from main 831ac90ef, before the shared route list
 * (src/appPages.tsx) replaced the three hand-kept copies in App.tsx,
 * pagePermissions.ts and Sidebar.tsx. It records:
 *   - routes: for every router path, each role, and with and without that page
 *     on the user's deny list, where the user ends up and which page renders.
 *     The real route tree and the real ProtectedRoute guards run; only the page
 *     bodies are swapped for a marker, so route matching and redirects are real.
 *   - sidebar: every role's sidebar links, in order, with no deny list, with each
 *     page denied in turn, and with the split-billing flag on.
 *   - permissions: the page-permission list the Settings screen and the command
 *     palette read, plus the exempt list.
 *
 * A deliberate access or sidebar change re-records it with
 *   UPDATE_ROUTE_BASELINE=1 npx vitest run src/routeBaseline.test.tsx
 * and the PR says which rows changed and why.
 */
import { cloneElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { MemoryRouter, Outlet, RouterProvider, createMemoryRouter, type RouteObject } from 'react-router-dom';
import type { UserRole } from './types';

const auth = vi.hoisted(() => ({
  role: 'admin' as string,
  deniedPages: [] as string[],
  splitBilling: false,
}));

vi.mock('virtual:pwa-register/react', () => ({
  useRegisterSW: () => ({ needRefresh: [false, () => {}], offlineReady: [false, () => {}], updateServiceWorker: () => {} }),
}));

vi.mock('./contexts/AuthContext', () => ({
  AuthProvider: ({ children }: { children: ReactNode }) => children,
  useAuth: () => ({
    session: { user: { id: 'u1' } },
    profile: { id: 'u1', role: auth.role, full_name: 'Test User', is_active: true },
    role: auth.role,
    deniedPages: auth.deniedPages,
    loading: false,
    signOut: () => {},
  }),
}));

// Only the Sidebar's split-billing flag read reaches the database here.
vi.mock('./lib/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./lib/db')>();
  const query = {
    select: () => query,
    eq: () => query,
    maybeSingle: async () => ({ data: { setting_value: auth.splitBilling ? 'true' : 'false' }, error: null }),
  };
  return { ...actual, supabase: { ...actual.supabase, from: () => query } };
});

import { appRoutes } from './App';
import ProtectedRoute from './components/auth/ProtectedRoute';
import Sidebar from './components/layout/Sidebar';
import {
  PAGE_PERMISSIONS,
  EXEMPT_ROUTE_SEGMENTS,
  getPageKeyFromPath,
  getPagesForRole,
  getCategories,
} from './lib/pagePermissions';

const ROLES: UserRole[] = ['admin', 'sales_rep', 'applicator', 'driver'];
const BASELINE_PATH = resolve(__dirname, 'routeBaseline.json');

afterEach(() => cleanup());

// ── Describing what a route renders ─────────────────────────────────────

const LAZY = Symbol.for('react.lazy');
const SUSPENSE = Symbol.for('react.suspense');

function typeName(type: unknown): string {
  if (typeof type === 'string') return type;
  if (type === SUSPENSE) return 'Suspense';
  const t = type as { $$typeof?: symbol; _payload?: { _result?: unknown }; name?: string };
  if (t?.$$typeof === LAZY) {
    // An unloaded lazy page keeps its import function; its source names the file, and
    // the export it picks when that is not the default one.
    const source = String(t._payload?._result);
    const file = /(?:pages|components)\/[A-Za-z/]+/.exec(source);
    const picked = /default:\s*m\.(\w+)/.exec(source);
    return `lazy ${file ? file[0] : '?'}${picked ? ` (export ${picked[1]})` : ''}`;
  }
  if (typeof type === 'function') return t.name || 'anonymous';
  return String(type);
}

function describeNode(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(describeNode);
  if (!isValidElement(node)) return node ?? null;
  const { children, fallback: _fallback, ...rest } = node.props as Record<string, unknown>;
  const props = Object.fromEntries(Object.keys(rest).sort().map((k) => [k, describeNode(rest[k])]));
  const out: Record<string, unknown> = { type: typeName(node.type) };
  if (Object.keys(props).length) out.props = props;
  if (children !== undefined) out.children = describeNode(children);
  return out;
}

const isGuard = (el: unknown): el is ReactElement<{ children?: ReactNode }> =>
  isValidElement(el) && el.type === ProtectedRoute;

function pageOf(element: ReactNode): unknown {
  let el: unknown = element;
  while (isGuard(el)) el = el.props.children;
  return describeNode(el);
}

// ── Route access ────────────────────────────────────────────────────────

interface Leaf { pattern: string; page: unknown }

function joinPath(parent: string, route: RouteObject): string {
  if (route.index || !route.path) return parent;
  if (route.path.startsWith('/')) return route.path;
  return `${parent === '/' ? '' : parent}/${route.path}`;
}

/**
 * The real route tree with each page body swapped for a marker naming the route.
 * Layouts become plain outlets; every ProtectedRoute guard stays exactly as written.
 */
function harnessRoutes(routes: RouteObject[], parent: string, leaves: Leaf[]): RouteObject[] {
  return routes.map((route) => {
    const pattern = joinPath(parent, route);
    if (route.children) {
      const element = isGuard(route.element) ? cloneElement(route.element, undefined, <Outlet />) : <Outlet />;
      return { ...route, element, children: harnessRoutes(route.children, pattern, leaves) } as RouteObject;
    }
    const key = route.index ? `${pattern || '/'} (index)` : pattern;
    leaves.push({ pattern: key, page: pageOf(route.element) });
    const marker = <output data-route={key} />;
    const element = isGuard(route.element) ? cloneElement(route.element, undefined, marker) : marker;
    return { ...route, element } as RouteObject;
  });
}

function sampleUrl(pattern: string): string {
  if (pattern === '/*') return '/no-such-page';
  return pattern.replace(/ \(index\)$/, '').replace(/:[a-z]+/gi, 'id-123');
}

async function visit(routes: RouteObject[], url: string): Promise<string> {
  const router = createMemoryRouter(routes, { initialEntries: [url] });
  const { container } = render(<RouterProvider router={router} />);
  for (let i = 0; i < 3; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  const { pathname, search } = router.state.location;
  const rendered = container.querySelector('output')?.getAttribute('data-route') ?? 'nothing';
  cleanup();
  router.dispose();
  return `${pathname}${search} shows ${rendered}`;
}

async function recordRoutes() {
  const leaves: Leaf[] = [];
  const routes = harnessRoutes(appRoutes, '', leaves);
  // Rows are keyed by path, so a second route at the same path would hide behind the
  // first one's row while the router picks one of them. Each path must appear once.
  const patterns = leaves.map((l) => l.pattern);
  expect(patterns.filter((p, i) => patterns.indexOf(p) !== i), 'duplicate route paths').toEqual([]);
  const out: Record<string, unknown> = {};
  for (const leaf of [...leaves].sort((a, b) => a.pattern.localeCompare(b.pattern))) {
    const url = sampleUrl(leaf.pattern);
    const ownKey = getPageKeyFromPath(url);
    const access: Record<string, string> = {};
    for (const role of ROLES) {
      auth.role = role;
      auth.deniedPages = [];
      access[role] = await visit(routes, url);
      if (ownKey && role !== 'admin') {
        auth.deniedPages = [ownKey];
        access[`${role}, ${ownKey} denied`] = await visit(routes, url);
      }
    }
    out[leaf.pattern] = { url, pageKey: ownKey, page: leaf.page, access };
  }
  return out;
}

// ── Sidebar ─────────────────────────────────────────────────────────────

async function sidebarLinks(): Promise<string[]> {
  const { container } = render(
    <MemoryRouter initialEntries={['/team-board']}>
      <Sidebar mobileOpen onClose={() => {}} />
    </MemoryRouter>,
  );
  for (let i = 0; i < 3; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  const lines: string[] = [];
  // The phone drawer lists every group heading and every link, always expanded.
  const drawer = container.querySelector('#mobile-navigation-drawer nav');
  drawer?.querySelectorAll('a, span.uppercase').forEach((el) => {
    lines.push(el.tagName === 'A' ? `${el.textContent} -> ${el.getAttribute('href')}` : `[${el.textContent}]`);
  });
  // The desktop rail: group buttons and top-level links, in order.
  lines.push('-- desktop --');
  container.querySelectorAll('aside[role="navigation"] nav a, aside[role="navigation"] nav button').forEach((el) => {
    lines.push(el.tagName === 'A' ? `${el.textContent} -> ${el.getAttribute('href')}` : `button ${el.getAttribute('aria-label')}`);
  });
  cleanup();
  return lines;
}

async function recordSidebar() {
  const out: Record<string, string[]> = {};
  const keys = PAGE_PERMISSIONS.map((p) => p.key);
  for (const role of ROLES) {
    auth.role = role;
    auth.splitBilling = false;
    auth.deniedPages = [];
    out[role] = await sidebarLinks();
    auth.splitBilling = true;
    out[`${role}, split billing on`] = await sidebarLinks();
    auth.splitBilling = false;
    if (role === 'admin') continue; // admins ignore the deny list
    for (const key of keys) {
      auth.deniedPages = [key];
      const links = await sidebarLinks();
      // Store only deny lists that change this role's sidebar.
      if (JSON.stringify(links) !== JSON.stringify(out[role])) out[`${role}, ${key} denied`] = links;
    }
  }
  auth.deniedPages = [];
  return out;
}

// ── Permission list ─────────────────────────────────────────────────────

function recordPermissions() {
  return {
    pages: PAGE_PERMISSIONS,
    exempt: [...EXEMPT_ROUTE_SEGMENTS].sort(),
    byRole: Object.fromEntries(ROLES.map((role) => {
      const pages = getPagesForRole(role);
      return [role, { keys: pages.map((p) => p.key), categories: getCategories(pages) }];
    })),
  };
}

describe('route, permission and sidebar baseline', () => {
  it('matches routeBaseline.json for every route, role and sidebar', async () => {
    const current = {
      routes: await recordRoutes(),
      sidebar: await recordSidebar(),
      permissions: recordPermissions(),
    };
    if (process.env.UPDATE_ROUTE_BASELINE === '1') {
      writeFileSync(BASELINE_PATH, `${JSON.stringify(current, null, 2)}\n`);
    }
    const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf-8'));
    expect(current.routes).toEqual(baseline.routes);
    expect(current.sidebar).toEqual(baseline.sidebar);
    expect(current.permissions).toEqual(baseline.permissions);
  }, 120_000);
});
