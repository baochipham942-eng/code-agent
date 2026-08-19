import { defineConfig } from '@playwright/test';
import os from 'node:os';
import path from 'node:path';
import { resolveE2eWebPort } from './e2eWebPort';

delete process.env.FORCE_COLOR;
delete process.env.NO_COLOR;

const useLocalAgentModel = process.env.CODE_AGENT_E2E_LOCAL_AGENT_MODEL === '1';
const webPort = resolveE2eWebPort({ explicitPort: process.env.E2E_WEB_PORT });
// sticky：Playwright 每个 worker 进程会重新评估本 config，写回 env 让 worker 走显式分支，
// 否则各 worker 按自己的 PID 再派生一次端口，与 webServer 实际监听口错开（CI 实翻过车）。
process.env.E2E_WEB_PORT = String(webPort);
// 走 stderr：config 会被 knip 等工具加载，stdout 打印会污染它们的 JSON 输出（CI 实翻过车）
console.error(`  E2E web port: ${webPort}${process.env.E2E_WEB_PORT ? ' (explicit)' : ' (derived from PID)'}`);
const browserChannel = process.env.E2E_BROWSER_CHANNEL || undefined;
const recordVideo = process.env.E2E_DISABLE_VIDEO === '1' ? 'off' : 'retain-on-failure';
const reuseExistingServer = !process.env.CI && !process.env.E2E_WEB_PORT && !useLocalAgentModel;
const e2eHome = process.env.CODE_AGENT_E2E_HOME
  || path.join(os.tmpdir(), `code-agent-e2e-home-${webPort}`);
const e2eDataDir = process.env.CODE_AGENT_E2E_DATA_DIR
  || path.join(os.tmpdir(), `code-agent-e2e-data-${webPort}`);
// ============================================================================
// 【已退役】「已过引导」设置固件 seedE2eSettings（2026-08-19 产品负责人拍板撤除）
// ============================================================================
// 曾经在这里调用 seedE2eSettings(e2eDataDir)：webServer 启动前往数据目录写一份
// config.json，让 settings.ipc.ts:326 的 handleCheckApiKeyConfigured 认为引导已完成
// （判据是 settings.onboarding.completedAt 有值），从源头不弹 AuthModal / ModelOnboardingModal。
//
// 🔴 为什么撤：**它的反向变异两轮都没红**——摘掉固件跑，用例该绿的照样绿，
//    也就是拿不出「这个固件在承重」的证据。唯一量到的差别是
//    「裸数据目录 t≈3s 时 dialogs=1，加固件全程 dialogs=0」。
//    按本仓规矩（门必须能报告自己的盲区、验收断言要有承重证据），
//    一个证明不了自己有用的稳定器留在门里，将来排查时会是第一个可疑对象却又无法排除。
//
// 🔴 什么信号出现时该把它加回来（这是撤除时约定的复发判据，别凭印象改）：
//    e2e 出现**成片**的「元素找不到 / 被遮挡」，且失败集中在剧本开头 3 秒内的断言，
//    手工复现时能看到 AuthModal 或 ModelOnboardingModal 盖住界面
//    ——那就是这里描述的竞态真的发生了（机器慢、CI 抢占、启动延迟变长都可能触发）。
//    到那时它有了承重证据，加回来是对的，而且**那时才写得出会红的反向变异**。
//
// 实现原文见 git：`git show a055e75d8 -- tests/e2e/seedE2eSettings.ts`（PR #1246 引入），
// 撤除经过见私档 docs/evidence/2026-08-18-N-E2E-CONTRACT.md 与本次退役记录。
// 兜底仍在：tests/e2e/firstRunDialogs.ts 的 dismissFirstRunDialogs（点掉已经弹出来的层）。
// ============================================================================

export default defineConfig({
  testDir: '.',
  testMatch: ['**/*.spec.ts'],
  // 这三个剧本**自带 webServer**（prepareFakeHome + spawn dist/web/webServer.cjs）和自己的
  // 系统 Chrome，归 playwright.system-chrome.config.ts 管（见 package.json 的
  // test:e2e:goal-mode / test:e2e:model-strategy）。之前它们也被本 config 收进来，
  // 于是一次全量跑里同时活着两套 webServer——2026-08-18 实测：跑到
  // model-strategy-recommendation 时**共享 webServer 直接消失**（日志无任何关闭记录），
  // 其后 32 个用例全挂在 ERR_CONNECTION_REFUSED，把真实红点整个淹掉。
  // 「不带文件名跑本 config」必须是一件可复现的事，所以在契约层把它们排除。
  testIgnore: [
    '**/goal-mode.spec.ts',
    '**/model-strategy-recommendation.spec.ts',
    '**/slash-commands.spec.ts',
  ],
  fullyParallel: false,
  workers: 1,
  // ADR-010 #1: CI flake 重试上限 1 次，本地开发保持 0。
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]] : 'list',
  timeout: 60000,
  use: {
    baseURL: `http://127.0.0.1:${webPort}`,
    ...(browserChannel ? { channel: browserChannel } : {}),
    // ADR-010 #1: 失败（或重试）时强制保留 trace + 截图作为 CI artifact。
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: recordVideo,
  },
  webServer: {
    command: `cd ../.. && npm run build:web && npm run build:renderer && WEB_HOST=127.0.0.1 WEB_PORT=${webPort} node dist/web/webServer.cjs`,
    port: webPort,
    reuseExistingServer,
    timeout: 180000,
    env: {
      // Enables /api/dev/emit-swarm-event for swarm-chain.spec.ts.
      // Benign for other specs — the route 404s unless this flag is set.
      CODE_AGENT_E2E: '1',
      // 不关掉热更新，webServer 会优先 serve <数据目录>/renderer-cache/active（启动时从云端拉的
      // bundle），把刚构建的本地 renderer 整个盖住 —— e2e 于是在测线上包而不是这次的改动。
      // 2026-07-25 实测：新加的 data-testid 三轮找不到，DOM 里还是上一版的文案。
      CODE_AGENT_DISABLE_RENDERER_HOT_UPDATE: '1',
      HOME: e2eHome,
      CODE_AGENT_HOME: e2eHome,
      CODE_AGENT_DATA_DIR: e2eDataDir,
      ...(useLocalAgentModel ? { CODE_AGENT_E2E_LOCAL_AGENT_MODEL: '1' } : {}),
    },
  },
});
