import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      // electron alias 保留作为安全网（第三方库可能 require('electron')）
      electron: path.resolve(__dirname, 'src/host/platform/index.ts'),
      // keytar 原生模块为 Electron Node.js 编译，在系统 Node.js 中会 SIGSEGV
      keytar: path.resolve(__dirname, 'tests/__mocks__/keytar.ts'),
      // react-konva → konva/index-node 在系统 Node 下 require('canvas') 崩溃，用 stub 兜底
      'react-konva': path.resolve(__dirname, 'tests/__mocks__/react-konva.ts'),
      // tsconfig paths — 让 @shared/@renderer/@host 别名在 vitest 中生效
      '@shared': path.resolve(__dirname, 'src/shared'),
      '@renderer': path.resolve(__dirname, 'src/renderer'),
      '@host': path.resolve(__dirname, 'src/host'),
      '@': path.resolve(__dirname, 'src'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./tests/setup.ts'],
    globalSetup: ['./tests/globalSetup.ts'],
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx', 'src/design/**/*.test.ts'],
    // 排除需要特殊处理的原生模块测试
    exclude: [
      '**/node_modules/**',
      '**/graphStore.test.ts', // Kuzu 原生模块需要单独运行
      '**/e2e/claude-e2e/fixtures/**', // legacy manual harness fixtures, not root unit/e2e suite
      // smoke 测试会真实操作桌面（open -a Calculator / osascript / 真 chromium 启动），
      // 混在默认全量跑会导致 Dock 图标乱跳、计算器弹出。需要显式指定文件路径单独跑：
      //   npx vitest run tests/smoke/<name>.smoke.test.ts
      '**/tests/smoke/**',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'json', 'html'],
      all: true,
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/**/*.d.ts',
        'src/**/__tests__/**',
        'src/host/tools/media/ppt/__tests__/**',
      ],
      thresholds: {
        statements: 38,
        branches: 34,
        functions: 36,
        lines: 39,
      },
    },
    testTimeout: 30000,
    hookTimeout: 10000,
  },
});
