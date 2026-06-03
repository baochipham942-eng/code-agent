// 临时配置：用系统 Chrome 跑 e2e（chromium 二进制下载不可用时的替代路径）。
// 与 playwright.e2e.config.ts 唯一区别：channel: 'chrome' + 不自起 webServer（要求 8180 已有服务）。
import { defineConfig } from '@playwright/test';

const webPort = Number(process.env.E2E_WEB_PORT || 8180);

export default defineConfig({
  testDir: '.',
  testMatch: ['**/*.spec.ts'],
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  timeout: 60000,
  use: {
    baseURL: `http://127.0.0.1:${webPort}`,
    channel: 'chrome',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
