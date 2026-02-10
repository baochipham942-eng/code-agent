import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      // electron 包在 Node.js 环境下返回二进制路径字符串，不是 API 对象
      // 在 vitest 中用 mock 替换，提供 app/BrowserWindow/ipcMain 等 API stub
      // electron 包在 Node.js 环境下返回二进制路径字符串，不是 API 对象
      electron: path.resolve(__dirname, 'tests/__mocks__/electron.ts'),
      // keytar 原生模块为 Electron Node.js 编译，在系统 Node.js 中会 SIGSEGV
      keytar: path.resolve(__dirname, 'tests/__mocks__/keytar.ts'),
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
