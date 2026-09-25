import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: ['**/geometry-sensor.regressions.spec.ts'],
  workers: 1,
  retries: 0,
  timeout: 60_000,
  use: { headless: true, viewport: { width: 1440, height: 900 } },
  reporter: [['list']],
});
