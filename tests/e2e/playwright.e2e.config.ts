// Playwright config for Electron E2E tests — no webServer (we manage Vite separately)
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: ['**/*.spec.ts'],
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  timeout: 60000,
  use: {
    baseURL: 'http://127.0.0.1:8180',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'cd ../.. && npm run build:web && npm run build:renderer && WEB_HOST=127.0.0.1 WEB_PORT=8180 node dist/web/webServer.cjs',
    port: 8180,
    reuseExistingServer: !process.env.CI,
    timeout: 180000,
    env: {
      // Enables /api/dev/emit-swarm-event for swarm-chain.spec.ts.
      // Benign for other specs — the route 404s unless this flag is set.
      CODE_AGENT_E2E: '1',
    },
  },
});
