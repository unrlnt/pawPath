import ErrorBoundary from './components/ErrorBoundary';
import MapPage from './components/map/MapPage';

/**
 * One route: the map is the landing view (CLAUDE.md §2.5). Share links are a
 * URL hash read by the route planner, so no router is needed.
 */
export default function App() {
  return (
    <ErrorBoundary>
      <MapPage />
    </ErrorBoundary>
  );
}
