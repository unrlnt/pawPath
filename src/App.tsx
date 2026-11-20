import { useEffect, useState } from 'react';

import MapPage from './components/map/MapPage';
import ReconPage from './components/recon/ReconPage';

/**
 * Routing is one comparison because there are two routes. A router gets added
 * if and when Phase 7's share links need one.
 *
 * Both forms address the same route, and neither needs a code change:
 *   http://localhost:5173/recon    — path, via Vite's SPA fallback
 *   http://localhost:5173/#/recon  — hash, works on any static host too
 * The hash wins if both are present.
 */
function currentRoute(): string {
  const hash = window.location.hash.replace(/^#/, '');
  return hash.length > 0 ? hash : window.location.pathname;
}

export default function App() {
  const [route, setRoute] = useState(currentRoute);

  useEffect(() => {
    const update = (): void => {
      setRoute(currentRoute());
    };
    window.addEventListener('hashchange', update);
    window.addEventListener('popstate', update);
    return () => {
      window.removeEventListener('hashchange', update);
      window.removeEventListener('popstate', update);
    };
  }, []);

  if (route === '/recon') {
    // The recon page is a Phase 1 measurement tool, not a product surface. It
    // hammers Overpass on demand, so it never ships in a production build.
    return import.meta.env.DEV ? <ReconPage /> : <NotAvailable />;
  }

  // The map is the landing view — not a list, not a dashboard (CLAUDE.md §2.5).
  return <MapPage />;
}

function NotAvailable() {
  return (
    <main className="flex min-h-full items-center justify-center p-6 text-center text-sm text-slate-600">
      Not available in production builds.
    </main>
  );
}
