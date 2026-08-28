import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: ['turn-feedback-why-visual.spec.ts'],
  fullyParallel: false,
  reporter: 'line',
  use: {
    ...devices['Desktop Chrome'],
    baseURL: 'http://127.0.0.1:5189',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npx vite --config renderer/visual/turn-feedback-why.vite.config.ts',
    port: 5189,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
