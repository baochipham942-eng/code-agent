import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  define: { __FIXTURES__: JSON.stringify(process.env.NEO_MOBILE_FIXTURES === '1') },
  build: { target: 'es2020' },
});
