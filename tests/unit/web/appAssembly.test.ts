import http from 'node:http';
import { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, type CreateAppDeps } from '../../../src/web/app';
import {
  getApplicationRunRegistry,
  resetApplicationRunRegistryForTests,
} from '../../../src/host/app/applicationRunRegistry';

// ============================================================================
// 装配测试：middleware 挂载顺序 + 路由注册完整性 + 生命周期
// ============================================================================
// createApp() 是从 webServer.ts 抽出的纯装配 seam（无 import 期副作用），本文件
// 是它第一批装配测试 —— 此前 webServer.ts 因顶层副作用（webEnvInit / host/platform /
// observability）无法被 import，路由表/中间件顺序/启停生命周期从未有过测试覆盖。
// ============================================================================

interface StackLayer {
  name: string;
  route?: { path: string; methods: Record<string, boolean> };
  handle?: { stack?: StackLayer[] };
}

function getStack(app: ReturnType<typeof createApp>): StackLayer[] {
  return (app as unknown as { router: { stack: StackLayer[] } }).router.stack;
}

/** DFS 展开所有 route 叶子节点（跳过 router 包装层和裸 middleware），得到扁平 method+path 表 */
function collectRoutes(stack: StackLayer[]): Array<[string, string]> {
  const rows: Array<[string, string]> = [];
  for (const layer of stack) {
    if (layer.route) {
      for (const method of Object.keys(layer.route.methods)) {
        rows.push([method, layer.route.path]);
      }
    } else if (layer.handle?.stack) {
      rows.push(...collectRoutes(layer.handle.stack));
    }
  }
  return rows;
}

function buildDeps(dataDir: string): CreateAppDeps {
  return {
    handlers: new Map(),
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    runRegistry: getApplicationRunRegistry(),
    pendingLocalToolCalls: new Map(),
    pendingDevPermissions: new Map(),
    resolveCodeAgentDataDir: () => dataDir,
    getAppVersion: () => '0.0.0-test',
    getDurableRunRollout: () => ({
      policy: {
        mode: 'legacy',
        configuredValue: null,
        valid: true,
        durableActivation: false,
        durableReadPreference: false,
      },
      ready: false,
    }),
    getDurableRunReadService: () => undefined,
  };
}

// 期望路由表（契约快照）：method + path，顺序即挂载顺序。改动任何一项都必须是
// 有意为之的路由变更，而不是重构/合并时的静默丢失。
const EXPECTED_ROUTES: Array<[string, string]> = [
  ['get', '/health'],
  ['get', '/events'],
  ['post', '/api/upload/temp'],
  ['get', '/api/screenshot'],
  // dev router: devCancellableToolSmoke sub-router
  ['post', '/start'],
  ['post', '/:id/cancel'],
  ['get', '/:id'],
  ['post', '/:id/status'],
  ['delete', '/:id'],
  // dev router: devAgentLoopStubSmoke sub-router
  ['post', '/'],
  ['get', '/:sessionId'],
  ['delete', '/:sessionId'],
  // dev router: devAgentTeamSmoke sub-router
  ['post', '/'],
  // dev router: flat routes
  ['get', '/workspace/file'],
  ['post', '/dev/exec-tool'],
  ['post', '/dev/smoke/office'],
  ['post', '/dev/background-task/complete'],
  ['get', '/dev/notifications'],
  ['delete', '/dev/notifications'],
  ['post', '/dev/emit-swarm-event'],
  ['post', '/dev/emit-agent-events'],
  ['post', '/dev/emit-workflow-events'],
  ['post', '/dev/emit-workflow-launch'],
  ['post', '/dev/telemetry/seed-turn'],
  ['post', '/dev/telemetry/upload'],
  ['post', '/dev/todos/seed'],
  ['get', '/dev/todos'],
  ['post', '/dev/compact-state/seed'],
  ['get', '/dev/compact-state'],
  ['get', '/dev/replay-state'],
  ['get', '/dev/telemetry/cloud-feedback'],
  ['get', '/dev/telemetry/cloud-trace'],
  // agent router
  ['post', '/run'],
  ['post', '/cancel'],
  ['post', '/pause'],
  ['post', '/resume'],
  ['post', '/interrupt'],
  ['post', '/tool-result'],
  // background router
  ['get', '/background/tasks'],
  ['post', '/background/move-to-background'],
  ['post', '/background/move-to-foreground'],
  // admin review queue router
  ['get', '/admin/review-queue'],
  ['post', '/admin/review-queue/issues'],
  ['post', '/admin/review-queue/:issueId/decision'],
  // sessions router
  ['get', '/sessions'],
  ['post', '/sessions'],
  ['get', '/sessions/:id'],
  ['get', '/sessions/:id/messages'],
  ['delete', '/sessions/:id'],
  ['post', '/sessions/:id/archive'],
  ['post', '/sessions/:id/unarchive'],
  // settings router
  ['get', '/settings'],
  ['put', '/settings'],
  // extract router
  ['post', '/extract/pdf'],
  ['post', '/extract/excel'],
  ['post', '/extract/excel-json'],
  ['post', '/extract/docx-html'],
  ['post', '/speech/transcribe'],
  // domain router (includes catch-all fallback)
  ['post', '/domain/:domain/:action'],
  ['_all', '/:channel/{*rest}'],
  // shell router
  ['get', '/shell/capabilities'],
  // static router (mounted at root, not under /api)
  ['get', '/{*path}'],
];

describe('web app assembly (createApp)', () => {
  afterEach(() => {
    resetApplicationRunRegistryForTests();
  });

  it('registers the full expected route table in mount order', () => {
    const app = createApp(buildDeps('/tmp/seam-assembly-route-table'));
    expect(collectRoutes(getStack(app))).toEqual(EXPECTED_ROUTES);
  });

  it('mounts cors -> rate limit -> auth -> json parser before any router/route', () => {
    const app = createApp(buildDeps('/tmp/seam-assembly-middleware-order'));
    const stack = getStack(app);

    const bareMiddlewareNames = stack
      .filter((layer) => !layer.route && !layer.handle?.stack)
      .map((layer) => layer.name);

    expect(bareMiddlewareNames).toEqual([
      'corsMiddleware',
      'rateLimitMiddleware',
      'authMiddleware',
      'jsonParser',
    ]);
  });

  it('runs auth (and the rate limiter mounted ahead of it) before every business route, including SSE', () => {
    const app = createApp(buildDeps('/tmp/seam-assembly-auth-order'));
    const stack = getStack(app);

    const indexOf = (name: string) => stack.findIndex((layer) => layer.name === name);
    const authIndex = indexOf('authMiddleware');
    const rateLimitIndex = indexOf('rateLimitMiddleware');
    expect(authIndex).toBeGreaterThan(-1);
    expect(rateLimitIndex).toBeGreaterThan(-1);
    expect(rateLimitIndex).toBeLessThan(authIndex);

    // 每个 router/直挂 route 的顶层 index 都必须晚于 auth（也就晚于其前面的限流）。
    // SSE 的 /events 路由由 health router 携带，覆盖到它即覆盖了 SSE 场景。
    stack.forEach((layer, index) => {
      const isRouterOrRoute = Boolean(layer.route) || Boolean(layer.handle?.stack);
      if (isRouterOrRoute) {
        expect(index).toBeGreaterThan(authIndex);
      }
    });

    const sseRouterIndex = stack.findIndex(
      (layer) => layer.handle?.stack && collectRoutes(layer.handle.stack).some(([, path]) => path === '/events'),
    );
    expect(sseRouterIndex).toBeGreaterThan(-1);
    expect(sseRouterIndex).toBeGreaterThan(rateLimitIndex);
    expect(sseRouterIndex).toBeGreaterThan(authIndex);
  });

  it('can be mounted on http.createServer, answers /api/health, and shuts down cleanly', async () => {
    const app = createApp(buildDeps('/tmp/seam-assembly-lifecycle'));
    const server = http.createServer(app);

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toMatchObject({ status: 'ok', mode: 'web-standalone' });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });
});
