import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Static SPA. Build output goes to dist/ and is uploaded to Cloudflare Pages
// as-is; there is no server component in phases 1-5.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
