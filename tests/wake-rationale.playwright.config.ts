import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: ['wake-rationale-visual.spec.ts'],
  fullyParallel: false,
  reporter: 'line',
  use: {
    ...devices['Desktop Chrome'],
    baseURL: 'http://127.0.0.1:5191',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npx vite --config renderer/visual/wake-rationale.vite.config.ts',
    port: 5191,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
