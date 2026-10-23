import { lazy, Suspense, useEffect, useRef } from 'react';
import { createBrowserRouter, RouterProvider, Navigate, Outlet, useLocation, type RouteObject } from 'react-router-dom';
import { AuthProvider } from './contexts/AuthContext';
import { ToastProvider } from './components/ui/Toast';
import { BelowCostApprovalProvider } from './contexts/BelowCostApprovalContext';
import ErrorBoundary from './components/ErrorBoundary';
import LoginPage from './components/auth/LoginPage';
import ForgotPasswordPage from './components/auth/ForgotPasswordPage';
import ResetPasswordPage from './components/auth/ResetPasswordPage';
import ProtectedRoute from './components/auth/ProtectedRoute';
import RoleLanding from './components/auth/RoleLanding';
import AppLayout from './components/layout/AppLayout';
import { checkEnvVars, EnvErrorScreen } from './components/EnvCheck';
import { trackNavigation } from './lib/metrics';
import UpdatePrompt from './components/UpdatePrompt';
import { APP_PAGES, type AppPage } from './appPages';

// Every other page is lazy-loaded in the shared page list, src/appPages.tsx.
const FieldApplicationInvoiceRoute = lazy(() => import('./components/FieldApplicationInvoiceRoute'));
// Design-system gallery — available on dev + preview hosts, hidden on the production domain.
const DesignPreview = lazy(() => import('./pages/DesignPreview'));
const SHOW_DESIGN_PREVIEW =
  import.meta.env.DEV ||
  (typeof window !== 'undefined' && !/(^|\.)croprxsolutions\.app$/.test(window.location.hostname));

// Simple loading spinner shown briefly while a page loads
function PageLoader() {
  return (
    <div className="flex items-center justify-center py-20">
      <div className="w-8 h-8 border-4 border-crx-green border-t-transparent rounded-full animate-spin" />
    </div>
  );
}

/**
 * Headless component that records a Sentry navigation breadcrumb
 * every time the route changes.  Renders nothing.
 */
function NavigationTracker() {
  const location = useLocation();
  const isFirstRender = useRef(true);

  useEffect(() => {
    // Skip the initial mount — the page-load is already captured by Sentry
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    trackNavigation(location.pathname);
  }, [location.pathname]);

  return null;
}

// Wraps each route's lazy-loaded page so a crash on one page doesn't
// take down the sidebar or prevent navigating to other pages.
function RouteShell() {
  return (
    <ErrorBoundary inline>
      <Suspense fallback={<PageLoader />}>
        <Outlet />
      </Suspense>
    </ErrorBoundary>
  );
}

// Root layout that wraps all routes with providers
function RootLayout() {
  return (
    <AuthProvider>
      <ToastProvider>
        <BelowCostApprovalProvider>
          <UpdatePrompt />
          <ErrorBoundary>
            <NavigationTracker />
            <Suspense fallback={<PageLoader />}>
              <Outlet />
            </Suspense>
          </ErrorBoundary>
        </BelowCostApprovalProvider>
      </ToastProvider>
    </AuthProvider>
  );
}

// Every page in the shared page list (src/appPages.tsx), each behind its role gate.
const pageRoutes: RouteObject[] = (APP_PAGES as readonly AppPage[]).flatMap((page) =>
  page.routes.map((route) => ({
    path: route.path,
    element: <ProtectedRoute allowedRoles={[...(route.roles ?? page.roles)]}>{route.element}</ProtectedRoute>,
  })),
);

// Exported so src/routeBaseline.test.tsx can check every route for every role.
// eslint-disable-next-line react-refresh/only-export-components
export const appRoutes: RouteObject[] = [
  // Dev-only design-system gallery — top-level (outside the auth provider) so it
  // renders standalone for visual verification. Excluded from production builds.
  ...(SHOW_DESIGN_PREVIEW
    ? [{ path: '/design-preview', element: <Suspense fallback={<PageLoader />}><DesignPreview /></Suspense> }]
    : []),
  {
    element: <RootLayout />,
    children: [
      { path: 'login', element: <LoginPage /> },
      { path: 'forgot-password', element: <ForgotPasswordPage /> },
      { path: 'reset-password', element: <ResetPasswordPage /> },
      {
        element: (
          <ProtectedRoute>
            <AppLayout />
          </ProtectedRoute>
        ),
        children: [{
          // RouteShell wraps all authenticated pages with an inline ErrorBoundary
          // so a crash on one page keeps the sidebar/nav functional.
          element: <RouteShell />,
          children: [
          { index: true, element: <RoleLanding /> },
          ...pageRoutes,
          // The Field Invoices page's field-application editor. Written out here rather than
          // in src/appPages.tsx only because src/pages/FieldApplicationInvoice.test.tsx pins
          // these lines; pagePermissions.test.ts fails if their roles stop matching that
          // page's, or if any other route is added here by hand.
          { path: 'invoices/field-app/new', element: <ProtectedRoute allowedRoles={['admin', 'sales_rep']}><FieldApplicationInvoiceRoute /></ProtectedRoute> },
          { path: 'invoices/field-app/:id', element: <ProtectedRoute allowedRoles={['admin', 'sales_rep']}><FieldApplicationInvoiceRoute /></ProtectedRoute> },
          ],
        }],
      },
      { path: '*', element: <Navigate to="/" replace /> },
    ],
  },
];

const router = createBrowserRouter(appRoutes);

export default function App() {
  const envCheck = checkEnvVars();

  if (!envCheck.isValid) {
    return <EnvErrorScreen missing={envCheck.missing} />;
  }

  return <RouterProvider router={router} />;
}
