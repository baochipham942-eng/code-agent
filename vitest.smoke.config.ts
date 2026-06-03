import { defineConfig } from 'vitest/config';
import baseConfig from './vitest.config';

/**
 * Smoke 测试专用配置 — 真实操作桌面/启动真实进程的测试。
 *
 * 这些测试会 open -a Calculator、跑 osascript、冷启动真 chromium，
 * 不能混进默认 `npm test` 全量跑（会导致 Dock 图标乱跳、计算器弹出）。
 *
 * 跑法：
 *   npm run test:smoke                                      # 全部 smoke
 *   npm run test:smoke -- tests/smoke/<name>.smoke.test.ts  # 单个
 */
const base = baseConfig as { resolve?: object; test?: object };

export default defineConfig({
  resolve: base.resolve,
  test: {
    ...base.test,
    include: ['tests/smoke/**/*.test.ts'],
    exclude: ['**/node_modules/**'],
    // chromium 冷启动 ×2 + Calculator AX 就绪等待
    testTimeout: 120_000,
    hookTimeout: 60_000,
    coverage: { enabled: false },
  },
});
