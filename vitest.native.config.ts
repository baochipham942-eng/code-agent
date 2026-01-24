import { defineConfig } from 'vitest/config';

/**
 * 原生模块测试配置
 *
 * 用于运行包含原生 Node 模块（如 Kuzu）的测试。
 * 使用 forks 池并禁用隔离，避免原生模块导致的 SIGSEGV。
 *
 * 使用方法:
 *   npm run test:native
 *   或
 *   npx vitest run --config vitest.native.config.ts
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/graphStore.test.ts'],
    // 使用 forks 池，禁用隔离
    pool: 'forks',
    isolate: false,
    fileParallelism: false,
    // 顺序执行测试文件
    sequence: {
      shuffle: false,
    },
    testTimeout: 60000,
    hookTimeout: 30000,
  },
});
