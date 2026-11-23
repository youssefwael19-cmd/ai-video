import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The dev server is started by the Express host (server/index.ts) in middleware mode,
// so Vite only needs to know how to serve and hot-reload the client app.
const previewHost = process.env.PREVIEW_HOSTNAME;

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: Number(process.env.PORT ?? 3000),
    strictPort: true,
    allowedHosts: previewHost ? [previewHost, 'localhost', '127.0.0.1'] : ['localhost', '127.0.0.1'],
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
