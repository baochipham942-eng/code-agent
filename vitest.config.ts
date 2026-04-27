import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      // electron alias 保留作为安全网（第三方库可能 require('electron')）
      electron: path.resolve(__dirname, 'src/main/platform/index.ts'),
      // keytar 原生模块为 Electron Node.js 编译，在系统 Node.js 中会 SIGSEGV
      keytar: path.resolve(__dirname, 'tests/__mocks__/keytar.ts'),
      // tsconfig paths — 让 @shared/@renderer/@main 别名在 vitest 中生效
      '@shared': path.resolve(__dirname, 'src/shared'),
      '@renderer': path.resolve(__dirname, 'src/renderer'),
      '@main': path.resolve(__dirname, 'src/main'),
      '@': path.resolve(__dirname, 'src'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.ts'],
    // 排除需要特殊处理的原生模块测试
    exclude: [
      '**/node_modules/**',
      '**/graphStore.test.ts', // Kuzu 原生模块需要单独运行
      '**/telemetry.test.ts', // API 签名不匹配（classifyIntent 接收 string 非 object），需重写
      '**/e2e/claude-e2e/fixtures/**', // legacy manual harness fixtures, not root unit/e2e suite
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
    },
    testTimeout: 30000,
    hookTimeout: 10000,
  },
});
