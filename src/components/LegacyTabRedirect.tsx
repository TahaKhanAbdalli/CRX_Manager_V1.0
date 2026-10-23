import { Navigate, useLocation } from 'react-router-dom';

interface LegacyTabRedirectProps {
  to: string;
  tab: string;
}

/** Sends an old standalone page's address to its tab on the page that replaced it, keeping the query. */
export default function LegacyTabRedirect({ to, tab }: LegacyTabRedirectProps) {
  const { search } = useLocation();
  const params = new URLSearchParams(search);
  params.set('tab', tab);
  return <Navigate to={`${to}?${params.toString()}`} replace />;
}
