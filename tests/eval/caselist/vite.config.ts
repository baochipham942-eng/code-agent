import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

const repositoryRoot = path.resolve(__dirname, '../../..');

export default defineConfig({
  root: __dirname,
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.join(repositoryRoot, 'src'),
      '@renderer': path.join(repositoryRoot, 'src/renderer'),
      '@shared': path.join(repositoryRoot, 'src/shared'),
    },
  },
  server: {
    host: '127.0.0.1',
    port: 4190,
    strictPort: true,
    fs: { allow: [repositoryRoot] },
  },
});
