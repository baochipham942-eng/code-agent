// ============================================================================
// N-TRIGGER-MAIL-CREATE-ENTRY-K1 ⑤ 截图专用 config：webServer 不是
// dist/web/webServer.cjs，而是 fakeMailWebServer.cjs（同款 esbuild 选项打包，
// 启动期经 getConnectorRegistry().register() 注入假 mail 连接器）。
// 形态由 NEO_FAKE_MAIL_STATE 选，每次进程跑一种（ready / not-authorized /
// unsupported / not-enabled）。不复用 e2e 主 config：共享 webServer 命令不同。
// ============================================================================

import { defineConfig } from '@playwright/test';
import os from 'node:os';
import path from 'node:path';

delete process.env.FORCE_COLOR;
delete process.env.NO_COLOR;

const webPort = Number(process.env.E2E_WEB_PORT ?? 23481);
const state = process.env.NEO_FAKE_MAIL_STATE ?? 'ready';
const e2eHome = path.join(os.tmpdir(), `neo-mail-shots-home-${webPort}-${state}`);
const e2eDataDir = path.join(os.tmpdir(), `neo-mail-shots-data-${webPort}-${state}`);

// 走 stderr：config 会先于命令执行，stdout 打印会污染管道消费方。
console.error(`  mail-shots web port: ${webPort} state: ${state}`);

export default defineConfig({
  testDir: '.',
  testMatch: ['**/cronMailEntryShots.spec.ts'],
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  timeout: 120000,
  use: {
    baseURL: `http://127.0.0.1:${webPort}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  webServer: {
    // fakeMailWebServer.cjs 由本单截图流程用 webServer 同款 esbuild 选项预构建
    //（见证据档；bundle gitignore，跑前重建）。
    command: `cd ../.. && npx esbuild tests/e2e/fakeMailWebServer.ts --bundle --platform=node --format=cjs --target=node24`
      + ` --external:better-sqlite3 --external:keytar --external:playwright --external:playwright-core`
      + ` --external:chromium-bidi --external:sharp --external:node-pty --external:@ui-tars/sdk --external:onnxruntime-node`
      + ` --alias:electron=./src/web/electronMock.ts --alias:pdfkit=pdfkit/js/pdfkit.standalone.js`
      + ` --outfile=dist/web/fakeMailWebServer.cjs`
      + ` && WEB_HOST=127.0.0.1 WEB_PORT=${webPort} NEO_FAKE_MAIL_STATE=${state} node dist/web/fakeMailWebServer.cjs`,
    port: webPort,
    reuseExistingServer: false,
    timeout: 180000,
    env: {
      CODE_AGENT_E2E: '1',
      CODE_AGENT_DISABLE_RENDERER_HOT_UPDATE: '1',
      NEO_FAKE_MAIL_STATE: state,
      HOME: e2eHome,
      CODE_AGENT_HOME: e2eHome,
      CODE_AGENT_DATA_DIR: e2eDataDir,
    },
  },
});
