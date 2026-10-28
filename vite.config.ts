import { defineConfig } from 'vite';

export default defineConfig({
  server: { port: 5173, open: false },
  build: { target: 'es2022', chunkSizeWarningLimit: 4000 },
  optimizeDeps: { exclude: ['@dimforge/rapier3d-compat'] },
});
