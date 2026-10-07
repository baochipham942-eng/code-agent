import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// N-HEALTH-SAFE-PROJECTION 台账验收③：读 detail-only 字段（pid/serverRoot/handlers/
// persistence/build.*）的调用方必须走带鉴权的 /api/health/detail；纯 liveness 检查
// （.ok / status / durableRunReady）留在公开 /api/health。本测试用结构断言钉住
// 「谁在读 detail 字段、谁就得带 token 走 detail 路由」，防止回退到公开路由后静默丢腿。
const readSource = (relative: string): string => readFileSync(path.resolve(relative), 'utf8');

interface DetailConsumer {
  file: string;
  required: RegExp[];
  forbidden?: RegExp[];
}

const DETAIL_CONSUMERS: DetailConsumer[] = [
  {
    // schedulerProbe 经 api() 助手调用（api() 自带 Bearer .dev-token）
    file: 'scripts/nightly/runtime.ts',
    required: [/api<[^>]*>\(state,\s*'health\/detail'\)/],
    forbidden: [/api\([^)]*state,\s*'health'\)/],
  },
  {
    file: 'scripts/acceptance/session-persistence-smoke.ts',
    required: [/fetch\(`\$\{server\.baseUrl\}\/api\/health\/detail`,\s*\{\s*headers:\s*\{ Authorization: `Bearer \$\{token\}`/],
    forbidden: [/fetch\(`\$\{server\.baseUrl\}\/api\/health`\)/],
  },
  {
    file: 'scripts/acceptance/manual-compact-smoke.ts',
    required: [/fetch\(`\$\{server\.baseUrl\}\/api\/health\/detail`,\s*\{\s*headers:\s*\{ Authorization: `Bearer \$\{token\}`/],
    forbidden: [/fetch\(`\$\{server\.baseUrl\}\/api\/health`\)/],
  },
  {
    file: 'scripts/acceptance/session-fork-smoke.ts',
    required: [/fetch\(`\$\{server\.baseUrl\}\/api\/health\/detail`,\s*\{\s*headers:\s*\{ Authorization: `Bearer \$\{token\}`/],
    forbidden: [/fetch\(`\$\{server\.baseUrl\}\/api\/health`\)/],
  },
  {
    // collector 验收④跑的脚本：pid/serverRoot/handlers/persistence 交叉核对走 detail，
    // detail 拿不到必须显式报失败（不允许静默降级丢 pid 腿）
    file: 'scripts/desktop-shell-packaged-smoke.mjs',
    required: [
      /healthDetailUrl = `\$\{baseUrl\}\/api\/health\/detail`/,
      /Authorization: `Bearer \$\{token\}`/,
      /desktop_shell_health_detail_missing/,
    ],
  },
  {
    file: 'scripts/acceptance/adr054-batch1-real-runtime.mjs',
    required: [/fetch\(`\$\{BASE_URL\}\/api\/health\/detail`[\s\S]{0,120}Authorization: `Bearer \$\{token\}`/],
    forbidden: [/fetch\(`\$\{BASE_URL\}\/api\/health`\)/],
  },
  {
    file: 'scripts/acceptance/adr054-batch2-real-runtime.mjs',
    required: [/fetch\(`\$\{BASE_URL\}\/api\/health\/detail`[\s\S]{0,120}Authorization: `Bearer \$\{token\}`/],
    forbidden: [/fetch\(`\$\{BASE_URL\}\/api\/health`\)/],
  },
  {
    file: 'scripts/acceptance/voice-p1b-dogfood.mjs',
    required: [/\/api\/health\/detail/, /Authorization: `Bearer \$\{token\}`/],
  },
  {
    file: 'scripts/acceptance/voiceprint-realtime-dogfood.ts',
    required: [/\/api\/health\/detail/, /Authorization: `Bearer \$\{token\}`/],
  },
  {
    file: 'scripts/acceptance/prevgen-fallback-real-runtime.mjs',
    required: [/fetch\(`\$\{url\}\/api\/health\/detail`,\s*\{\s*headers:\s*\{ Authorization: `Bearer \$\{token\}`/],
    forbidden: [/fetch\(`\$\{url\}\/api\/health`\)/],
  },
  {
    // assertEnv 读 health.build.commit 做剧本同源校验；createApi 自带 Bearer
    file: 'scripts/scenario/harness.mjs',
    required: [/api\.get\('\/api\/health\/detail'\)/],
    forbidden: [/api\.get\('\/api\/health'\)/],
  },
  {
    // 预检 serverRoot 做 workspace 路径围栏：必须带 token 走 detail 常量
    file: 'src/host/agent/runtime/browser/inAppArtifactPreviewHealth.ts',
    required: [
      /HEALTH_DETAIL_PATH/,
      /Authorization: `Bearer \$\{token\}`/,
    ],
    forbidden: [/new URL\(WEB_SERVER_DEFAULTS\.HEALTH_PATH,\s*baseUrl\)/],
  },
];

describe('health detail consumers use the authenticated /api/health/detail route', () => {
  for (const consumer of DETAIL_CONSUMERS) {
    it(`${consumer.file} fetches detail-only fields from /api/health/detail with a bearer token`, () => {
      const source = readSource(consumer.file);
      for (const pattern of consumer.required) {
        expect(source, `${consumer.file} should match ${String(pattern)}`).toMatch(pattern);
      }
      for (const pattern of consumer.forbidden ?? []) {
        expect(
          source,
          `${consumer.file} must not fetch detail-only fields from the public route (${String(pattern)})`,
        ).not.toMatch(pattern);
      }
    });
  }

  it('exposes the detail path next to the public health path constant', () => {
    const source = readSource('src/shared/constants/webServer.ts');
    expect(source).toMatch(/HEALTH_PATH:\s*'\/api\/health'/);
    expect(source).toMatch(/HEALTH_DETAIL_PATH:\s*'\/api\/health\/detail'/);
  });
});
