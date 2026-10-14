// ============================================================================
// 真 SDK 离线启动 → 网络恢复自愈测试（N-FEISHU-WS-FIRST-RETRY 验收⑤⑥）
// ----------------------------------------------------------------------------
// 不 mock SDK 的连接行为：真 @larksuiteoapi/node-sdk WSClient 经真 ChannelManager
// 跑完整链路，只把 domain 指到本地 stub（SDK formatDomain 对非枚举字符串透传）。
// 阶段一「离线启动」：本地无监听，pullConnectConfig 连接被拒 → 首连失败入退避；
// 阶段二「网络恢复」：起本地 stub（HTTP /callback/ws/endpoint + ws 服务），下一轮
// 重试自动连上。全程无需飞书凭据、不占 Dev 槽；测试内缩短退避 + 清掉代理变量。
// ============================================================================
import * as http from 'node:http';
import * as net from 'node:net';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import { getChannelManager } from '../../../src/host/channels';

const realSdk = vi.hoisted(() => ({
  httpPort: 0,
  wsPort: 0,
  logs: [] as string[],
}));

vi.mock('@larksuiteoapi/node-sdk', async () => {
  const actual = await vi.importActual<typeof import('@larksuiteoapi/node-sdk')>(
    '@larksuiteoapi/node-sdk',
  );
  type WsClientLike = new (opts: Record<string, unknown>) => {
    start: (params: unknown) => Promise<void>;
    close: (params?: { force?: boolean }) => void;
  };
  const RealWSClient = actual.WSClient as unknown as WsClientLike;
  // 只覆写 domain：把开放平台长连接配置接口指到本地 stub，其余行为全部走真 SDK。
  class LocalDomainWSClient extends RealWSClient {
    constructor(opts: Record<string, unknown>) {
      super({ ...opts, domain: `http://127.0.0.1:${realSdk.httpPort}` });
    }
  }
  return { ...actual, WSClient: LocalDomainWSClient };
});

vi.mock('../../../src/host/services/infra/logger', async () => {
  const actual = await vi.importActual<typeof import('../../../src/host/services/infra/logger')>(
    '../../../src/host/services/infra/logger',
  );
  const CAPTURED_CONTEXTS = new Set(['ChannelManager', 'ChannelReconnect']);
  return {
    ...actual,
    createLogger: (context: string, options?: Parameters<typeof actual.createLogger>[1]) => {
      const created = actual.createLogger(context, options);
      if (CAPTURED_CONTEXTS.has(context)) {
        // 在实例上包方法（沿用 feishuWsStatus.test.ts 的模式），保留原型上的其余行为
        const wrap = (level: 'info' | 'warn' | 'error', message: string, ...rest: unknown[]) => {
          realSdk.logs.push(`${context} ${level} ${message}${rest.length ? ` ${safeRest(rest)}` : ''}`);
        };
        created.info = ((message: string, ...rest: unknown[]) => {
          wrap('info', message, ...rest);
        }) as typeof created.info;
        created.warn = ((message: string, ...rest: unknown[]) => {
          wrap('warn', message, ...rest);
        }) as typeof created.warn;
        created.error = ((message: string, ...rest: unknown[]) => {
          wrap('error', message, ...rest);
        }) as typeof created.error;
      }
      return created;
    },
  };
});

function safeRest(rest: unknown[]): string {
  try {
    return JSON.stringify(rest[0] ?? {}).slice(0, 220);
  } catch {
    return '';
  }
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const port = (probe.address() as AddressInfo).port;
      probe.close(() => resolve(port));
    });
    probe.on('error', reject);
  });
}

async function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timeout waiting for ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

function startConfigStub(port: number): http.Server {
  return http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/callback/ws/endpoint') {
      req.resume();
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        code: 0,
        msg: 'ok',
        data: {
          URL: `ws://127.0.0.1:${realSdk.wsPort}/?device_id=neo-test&service_id=1`,
          ClientConfig: {
            PingInterval: 300,
            ReconnectCount: 3,
            ReconnectInterval: 3,
            ReconnectNonce: 0,
          },
        },
      }));
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  }).listen(port, '127.0.0.1');
}

describe('Feishu WS boot recovery (real SDK, local stub)', () => {
  let configStub: http.Server | null = null;
  let wsStub: WebSocketServer | null = null;
  let accountId: string | null = null;
  const savedEnv: Record<string, string | undefined> = {};
  const proxyVars = ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy'];

  beforeAll(async () => {
    // 测试内缩短重试起始等待（读于调度器构造，须在单例创建前设置）
    process.env.NEO_CHANNEL_CONNECT_RETRY_INITIAL_MS = '700';
    for (const key of proxyVars) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    realSdk.httpPort = await freePort();
    realSdk.wsPort = await freePort();
  });

  beforeEach(() => {
    realSdk.logs.length = 0;
  });

  afterEach(async () => {
    const manager = getChannelManager();
    if (accountId) {
      await manager.disconnectAccount(accountId).catch(() => undefined);
      await manager.deleteAccount(accountId).catch(() => undefined);
      accountId = null;
    }
    await new Promise<void>((resolve) => {
      if (!configStub) return resolve();
      configStub.close(() => resolve());
      configStub = null;
    });
    await new Promise<void>((resolve) => {
      if (!wsStub) return resolve();
      wsStub.close(() => resolve());
      wsStub = null;
    });
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('⑤ recovers by itself after offline boot once the local endpoint comes up', { timeout: 150_000 }, async () => {
    const manager = getChannelManager();
    const statusSeq: Array<{ status: string; message?: string }> = [];
    const onStatus = (_id: string, status: string, message?: string) => {
      statusSeq.push({ status, message });
    };
    manager.on('account_status_change', onStatus);

    const account = await manager.addAccount('real-sdk-recovery', 'feishu', {
      type: 'feishu',
      appId: 'cli_deadbeefdeadbeef',
      appSecret: 'local-stub-secret',
      useWebSocket: true,
    });
    accountId = account.id;

    // 阶段一：离线启动（本地两个端口都无监听）→ 首连失败进入退避；
    // 再放第 1 次重试也撞在无监听上，凑出「多轮失败 → 恢复」的完整序列
    const first = manager.connectAccount(account.id).catch((error: unknown) => error);
    await first;
    expect(manager.getAccount(account.id)?.status).toBe('connecting');
    expect(manager.getAccount(account.id)?.errorMessage).toContain('重连中（第 1 次）');
    await waitFor(
      () => (manager.getAccount(account.id)?.errorMessage ?? '').includes('第 2 次'),
      60_000,
      'second retry to be scheduled',
    );

    // 阶段二：网络恢复——起本地 stub（配置接口 + ws 服务），等下一轮自动重连连上
    configStub = startConfigStub(realSdk.httpPort);
    wsStub = new WebSocketServer({ port: realSdk.wsPort, host: '127.0.0.1' });
    await waitFor(
      () => manager.getAccount(account.id)?.status === 'connected',
      30_000,
      'account to become connected after local stub came up',
    );

    // 真实 SDK 建立的连接在 activeChannels 里，且只有这一个实例
    expect(manager.getActiveChannel(account.id)).toBeTruthy();

    manager.off('account_status_change', onStatus);

    // 主机日志与状态序列（证据粘贴用）
    process.stdout.write(`[realSdk] captured ${realSdk.logs.length} manager/scheduler log lines\n`);
    const relevant = realSdk.logs.filter((line) =>
      line.includes('connect failed')
      || line.includes('retry scheduled')
      || line.includes('retry firing')
      || line.includes('Retrying channel connect')
      || line.includes('Channel connected'));
    process.stdout.write(`\n[realSdk] host log lines:\n${relevant.map((l) => `  ${l}`).join('\n')}\n`);
    process.stdout.write(`[realSdk] status sequence:\n  ${JSON.stringify(statusSeq)}\n`);
    expect(statusSeq.at(-1)?.status).toBe('connected');
    expect(statusSeq.some((item) => item.status === 'error')).toBe(true);
  });
});
