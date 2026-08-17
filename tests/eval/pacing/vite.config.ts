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
    },
  },
  server: { host: '127.0.0.1', port: 4178, strictPort: true },
});
