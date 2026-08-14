import { spawn } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createShutdownStepCap,
  runShutdownFinalizers,
} from '../../../src/web/webShutdownFinalizers';
import { WEB_SERVER_SHUTDOWN_TIMEOUTS } from '../../../src/shared/constants/timeouts';

const disconnectAll = vi.fn(async () => {});
const getStdioChildPids = vi.fn((): number[] => []);
const shutdownPostHog = vi.fn(async () => {});
const langfuseCleanupAll = vi.fn(async () => {});
const langfuseShutdown = vi.fn(async () => {});
const cleanupSessionStateManager = vi.fn(() => {});
const disposeAgentRegistry = vi.fn(async () => {});

vi.mock('../../../src/host/mcp/mcpClient', () => ({
  getMCPClient: () => ({ disconnectAll, getStdioChildPids }),
}));
vi.mock('../../../src/host/observability/posthogNode', () => ({
  shutdownPostHog: () => shutdownPostHog(),
}));
vi.mock('../../../src/host/services/infra/langfuseService', () => ({
  getLangfuseService: () => ({
    cleanupAll: () => langfuseCleanupAll(),
    shutdown: () => langfuseShutdown(),
  }),
}));
vi.mock('../../../src/host/session/sessionStateManager', () => ({
  cleanupSessionStateManager: () => cleanupSessionStateManager(),
}));
vi.mock('../../../src/host/agent/agentRegistry', () => ({
  disposeAgentRegistry: () => disposeAgentRegistry(),
}));

const ALL_LABELS = [
  'mcp.disconnect',
  'posthog.flush',
  'langfuse.flush',
  'sessionState.cleanup',
  'agentRegistry.dispose',
];

beforeEach(() => {
  vi.clearAllMocks();
  disconnectAll.mockImplementation(async () => {});
  getStdioChildPids.mockImplementation(() => []);
  shutdownPostHog.mockImplementation(async () => {});
  langfuseCleanupAll.mockImplementation(async () => {});
  langfuseShutdown.mockImplementation(async () => {});
  disposeAgentRegistry.mockImplementation(async () => {});
});

describe('runShutdownFinalizers — 死文件 lifecycle.ts 记的责任，接进真属主', () => {
  it('正例：五步全跑到，且每步都在日志里留痕', async () => {
    const lines: string[] = [];
    await runShutdownFinalizers(1_000, (msg) => lines.push(msg));

    expect(disconnectAll).toHaveBeenCalledTimes(1);
    expect(shutdownPostHog).toHaveBeenCalledTimes(1);
    expect(langfuseCleanupAll).toHaveBeenCalledTimes(1);
    expect(langfuseShutdown).toHaveBeenCalledTimes(1);
    expect(cleanupSessionStateManager).toHaveBeenCalledTimes(1);
    expect(disposeAgentRegistry).toHaveBeenCalledTimes(1);

    expect(lines).toHaveLength(1);
    for (const label of ALL_LABELS) {
      expect(lines[0]).toContain(`${label}=ok(`);
    }
  });

  it('负例（故障注入）：一步抛错不影响其余四步，且日志指名道姓', async () => {
    shutdownPostHog.mockRejectedValueOnce(new Error('posthog boom'));
    const lines: string[] = [];

    await expect(runShutdownFinalizers(1_000, (msg) => lines.push(msg))).resolves.toBeUndefined();

    expect(lines[0]).toContain('posthog.flush=failed(posthog boom)');
    for (const label of ALL_LABELS.filter((l) => l !== 'posthog.flush')) {
      expect(lines[0]).toContain(`${label}=ok(`);
    }
    // 其余四步真的跑了，不是被短路掉
    expect(disconnectAll).toHaveBeenCalledTimes(1);
    expect(disposeAgentRegistry).toHaveBeenCalledTimes(1);
  });

  it('负例（挂死）：断连挂住时到上限跳过，并对幸存的 MCP 子进程补 SIGKILL', async () => {
    // 真进程：MCP server 无视 stdin 关闭时，SDK 的优雅阶梯（2s+2s）根本走不完宽限期，
    // 所以属主必须自己补刀。这里用一个真 sleep 进程验它确实被杀掉。
    const survivor = spawn('sleep', ['30'], { stdio: 'ignore' });
    const exited = new Promise<number | null>((resolve) => {
      survivor.on('exit', (_code, signal) => resolve(signal === 'SIGKILL' ? 1 : 0));
    });

    getStdioChildPids.mockImplementation(() => [survivor.pid as number]);
    disconnectAll.mockImplementation(() => new Promise<void>(() => {})); // 永不 resolve

    const lines: string[] = [];
    await runShutdownFinalizers(50, (msg) => lines.push(msg));

    expect(lines[0]).toContain('mcp.disconnect=timeout(');
    expect(lines[0]).toContain('mcp.killed=1/1');
    expect(await exited).toBe(1);
    // 挂死的那一步没有拖垮其它步骤
    expect(lines[0]).toContain('posthog.flush=ok(');
  });

  it('MCP 从没初始化过时不炸：无子进程、killed=0', async () => {
    const lines: string[] = [];
    await runShutdownFinalizers(1_000, (msg) => lines.push(msg));
    expect(lines[0]).toContain('mcp.killed=0/0');
  });
});

describe('createShutdownStepCap — 关库前总预算', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('每步上限收成 min(STEP_MS, 总预算剩余)，预算烧光后归零', () => {
    let clock = 0;
    const { stepMs } = createShutdownStepCap(2_000, () => clock);

    expect(stepMs()).toBe(WEB_SERVER_SHUTDOWN_TIMEOUTS.STEP_MS);
    clock = 1_500; // 已用掉 1.5s，只剩 500ms 预算
    expect(stepMs()).toBe(500);
    clock = 5_000; // 预算烧穿，绝不再向关库借时间
    expect(stepMs()).toBe(0);
  });

  it('步骤跑赢上限时不得打印「超时」——那行日志会把事后排查引到反方向', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { withCap } = createShutdownStepCap(2_000);

    await withCap(Promise.resolve('done'), 'fastStep');
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(warn).not.toHaveBeenCalled();
  });

  it('步骤挂死时到上限放行并留痕', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { withCap } = createShutdownStepCap(20);

    await withCap(new Promise<void>(() => {}), 'hungStep');

    expect(warn).toHaveBeenCalledWith('[shutdown] hungStep timed out, skipping');
  });
});

describe('接线守护：收尾步骤必须排在干净关库之前', () => {
  const source = readFileSync(
    join(process.cwd(), 'src/web/webServer.ts'),
    'utf-8',
  );

  it('webServer.shutdown 调了 runShutdownFinalizers，且排在 closeAllDatabaseConnections 之前', () => {
    const finalizers = source.indexOf('runShutdownFinalizers(');
    const closeDb = source.indexOf('closeAllDatabaseConnections()');

    expect(finalizers).toBeGreaterThan(-1);
    expect(closeDb).toBeGreaterThan(-1);
    expect(finalizers).toBeLessThan(closeDb);
  });

  it('预算在 shutdown 内创建（不是模块加载时），否则预算从进程启动就开始烧', () => {
    const shutdownStart = source.indexOf('const shutdown = async ()');
    const capCreated = source.indexOf('createShutdownStepCap()');

    expect(shutdownStart).toBeGreaterThan(-1);
    expect(capCreated).toBeGreaterThan(shutdownStart);
  });

  it('死文件 src/host/app/lifecycle.ts 已删，责任不再有第二个账本', () => {
    expect(() =>
      readFileSync(join(process.cwd(), 'src/host/app/lifecycle.ts'), 'utf-8'),
    ).toThrow();
  });
});
