import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const repoRoot = path.resolve(__dirname, '../../..');

export default defineConfig({
  root: repoRoot,
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.join(repoRoot, 'src'),
      '@renderer': path.join(repoRoot, 'src/renderer'),
      '@shared': path.join(repoRoot, 'src/shared'),
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5189,
    strictPort: true,
  },
});
