import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// `npm run dev -w @datatrust/web` proxies the API to the local Worker on 127.0.0.1:8792.
export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false },
  server: { port: 5173, proxy: { '/api': 'http://127.0.0.1:8792', '/healthz': 'http://127.0.0.1:8792' } },
});
