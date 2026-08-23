import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: ['share-link-panel-visual.spec.ts'],
  fullyParallel: true,
  reporter: 'line',
  use: {
    ...devices['Desktop Chrome'],
    baseURL: 'http://127.0.0.1:5174',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npx vite --config visual/vite.config.ts',
    port: 5174,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
