import type { UserRole } from '../types';
import { APP_PAGES, pagePath, type AppPage } from '../appPages';

export interface PagePermission {
  key: string;
  path: string;
  label: string;
  category: string;
  roles: UserRole[];
}

/**
 * Every permissionable page, derived from the shared page list in
 * src/appPages.tsx (the page's key, its own address, its Settings label and
 * group, and its roles), in that list's order. A page in that list with no
 * label and category has no entry here and is exempt instead (below), so every
 * signed-in route either has an entry or is exempt: ProtectedRoute's deny-list
 * check cannot silently miss a route. Add pages there, not here.
 */
const PAGES: readonly AppPage[] = APP_PAGES;

export const PAGE_PERMISSIONS: PagePermission[] = PAGES.flatMap((page) =>
  page.label && page.category
    ? [{ key: page.key, path: pagePath(page), label: page.label, category: page.category, roles: [...page.roles] }]
    : [],
);

/**
 * Page-key first-segments that intentionally have no PAGE_PERMISSIONS entry:
 * the sign-in pages outside the app, plus the pages in src/appPages.tsx with no
 * permission label (open to their listed roles, never on a deny list).
 * ProtectedRoute treats null `pageKey` as a routing bug UNLESS the segment is in
 * this set.
 */
export const EXEMPT_ROUTE_SEGMENTS: ReadonlySet<string> = new Set([
  'login',
  'forgot-password',
  'reset-password',
  ...PAGES.filter((page) => !(page.label && page.category)).map((page) => page.key),
]);

/**
 * Extract the page key from a route pathname.
 * e.g., '/quotes/new' → 'quotes', '/customers/abc-123' → 'customers'
 * Returns null for non-permissionable paths (team-board, settings, etc.)
 */
export function getPageKeyFromPath(pathname: string): string | null {
  const segments = pathname.replace(/^\//, '').split('/');
  const firstSegment = segments[0] || '';

  // The field-application invoice editor is mounted under /invoices/field-app/*
  // for route-reuse, but it belongs to the SEPARATE Field Invoices area.
  if (firstSegment === 'invoices' && segments[1] === 'field-app') {
    return 'field-invoices';
  }

  // Legacy standalone routes redirect into consolidated tabbed pages and
  // therefore share each destination's single permission/deny-list key.
  const legacyPageKey: Record<string, string> = {
    'receiving-hub': 'receiving',
    prepayments: 'prepay',
    'prepay-workspace': 'prepay',
    'integrity-report': 'integrity',
    'integrity-cleanup': 'integrity',
  };
  if (legacyPageKey[firstSegment]) return legacyPageKey[firstSegment];

  const found = PAGE_PERMISSIONS.find((p) => p.key === firstSegment);
  return found ? found.key : null;
}

/**
 * Returns true when a path's first segment is intentionally exempt from
 * PAGE_PERMISSIONS coverage (e.g. /settings, /login, /team-board).
 * The root path ('/' or '') is also exempt — it is the role landing redirect.
 */
export function isExemptRoute(pathname: string): boolean {
  const firstSegment = pathname.replace(/^\//, '').split('/')[0] || '';
  if (firstSegment === '') return true;
  return EXEMPT_ROUTE_SEGMENTS.has(firstSegment);
}

/**
 * Check if a user has access to a specific page.
 * 1. Admins always have access
 * 2. Role must be in the page's allowed roles
 * 3. Page must not be in the user's denied_pages list
 */
export function hasPageAccess(
  role: UserRole | null,
  deniedPages: string[],
  pageKey: string
): boolean {
  if (!role) return false;
  if (role === 'admin') return true;

  const page = PAGE_PERMISSIONS.find((p) => p.key === pageKey);
  if (!page) return false;

  if (!page.roles.includes(role)) return false;
  // Preserve profile restrictions saved under route keys that existed before
  // these standalone pages were consolidated.
  if (pageKey === 'receiving' && deniedPages.includes('receiving-hub')) return false;
  if (pageKey === 'prepay' && deniedPages.some((key) => key === 'prepayments' || key === 'prepay-workspace')) return false;
  if (pageKey === 'integrity' && deniedPages.some((key) => key === 'integrity-report' || key === 'integrity-cleanup')) return false;
  if (deniedPages.includes(pageKey)) return false;
  return true;
}

/** Get all pages accessible by a given role (before deny-list filtering). */
export function getPagesForRole(role: UserRole): PagePermission[] {
  if (role === 'admin') return PAGE_PERMISSIONS;
  return PAGE_PERMISSIONS.filter((p) => p.roles.includes(role));
}

/** Get unique categories from a list of pages, preserving order. */
export function getCategories(pages: PagePermission[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const p of pages) {
    if (!seen.has(p.category)) {
      seen.add(p.category);
      result.push(p.category);
    }
  }
  return result;
}
