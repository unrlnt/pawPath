import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import '@fontsource/fredoka/500.css';
import '@fontsource/fredoka/600.css';
import '@fontsource/nunito/400.css';
import '@fontsource/nunito/700.css';

import App from './App';
import './index.css';

const container = document.getElementById('root');
if (container === null) throw new Error('#root is missing from index.html');

// Installable app with an offline shell (Phase 11, PWA). Production only:
// in dev a service worker would cache files Vite is still changing.
if (import.meta.env.PROD && 'serviceWorker' in navigator && window.isSecureContext) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((cause: unknown) => {
      console.warn('[pwa] service worker not registered', cause);
    });
  });
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
