import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // 排除需要特殊处理的原生模块测试
    exclude: [
      '**/node_modules/**',
      '**/graphStore.test.ts', // Kuzu 原生模块需要单独运行
      '**/e2e/claude-e2e/fixtures/**', // 故意含 bug 的 E2E 夹具，不参与单元测试
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
    },
    testTimeout: 30000,
    hookTimeout: 10000,
  },
});
