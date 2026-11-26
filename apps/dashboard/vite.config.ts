import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const api = process.env.OAKENSHIELD_API ?? `http://127.0.0.1:${process.env.PORT ?? 8787}`;

export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.DASHBOARD_PORT ?? 5173),
    proxy: { '/api': { target: api, changeOrigin: true } },
  },
  build: {
    outDir: 'dist', sourcemap: true, chunkSizeWarningLimit: 900,
    // The landing page at /, the dashboard at /app/, and the 404 page.
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        app: fileURLToPath(new URL('./app/index.html', import.meta.url)),
        notFound: fileURLToPath(new URL('./404.html', import.meta.url)),
      },
    },
  },
});
