import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  root: __dirname,
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '../../../src/renderer'),
      '@shared': path.resolve(__dirname, '../../../src/shared'),
      '@pacing/convex-smooth': path.resolve(__dirname, '../../../node_modules/@convex-dev/agent/dist/react/useSmoothText.js'),
    },
  },
  server: { host: '127.0.0.1', port: 4178, strictPort: true },
});
