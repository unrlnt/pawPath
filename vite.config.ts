import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Static SPA. Build output goes to dist/ and is served by Caddy (Dockerfile
// target `web`); there is no server component.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    // The source is public anyway; maps would only double the image.
    sourcemap: false,
    // MapLibre is ~2/3 of the bundle and changes rarely: its own chunk stays
    // in visitors' caches across app releases (hashed names, immutable).
    chunkSizeWarningLimit: 1100,
    rollupOptions: {
      output: {
        manualChunks: (id) => {
          if (id.includes('node_modules/maplibre-gl')) return 'maplibre';
          if (/node_modules\/(react|react-dom|scheduler)\//.test(id)) return 'react';
          if (/node_modules\/(pmtiles|pbf|@mapbox)\//.test(id)) return 'tiles';
          return undefined;
        },
      },
    },
  },
});
