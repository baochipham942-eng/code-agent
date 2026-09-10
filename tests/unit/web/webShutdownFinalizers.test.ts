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
const stopPtyCleanupTimer = vi.fn(() => {});
const stopBackgroundTaskCleanupTimer = vi.fn(() => {});
const stopConnectorStatusWatcher = vi.fn(() => {});
const stopRateLimitCleanupTimer = vi.fn(() => {});

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
vi.mock('../../../src/host/tools/shell/ptyExecutor', () => ({
  stopPtyCleanupTimer: () => stopPtyCleanupTimer(),
}));
vi.mock('../../../src/host/tools/shell/backgroundTasks', () => ({
  stopBackgroundTaskCleanupTimer: () => stopBackgroundTaskCleanupTimer(),
}));
vi.mock('../../../src/host/ipc/connector.ipc', () => ({
  stopConnectorStatusWatcher: () => stopConnectorStatusWatcher(),
}));
vi.mock('../../../src/web/middleware/auth', () => ({
  stopRateLimitCleanupTimer: () => stopRateLimitCleanupTimer(),
}));

const ALL_LABELS = [
  'mcp.disconnect',
  'posthog.flush',
  'langfuse.flush',
  'sessionState.cleanup',
  'agentRegistry.dispose',
  'cleanupTimers.stop',
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
  it('正例：六步全跑到，且每步都在日志里留痕', async () => {
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

  it('N-SHUTDOWN-DEADLINK：原挂死表的四处定时器清理，活停机会跑到（各恰一次）', async () => {
    await runShutdownFinalizers(1_000, () => {});

    expect(stopPtyCleanupTimer).toHaveBeenCalledTimes(1);
    expect(stopBackgroundTaskCleanupTimer).toHaveBeenCalledTimes(1);
    expect(stopConnectorStatusWatcher).toHaveBeenCalledTimes(1);
    expect(stopRateLimitCleanupTimer).toHaveBeenCalledTimes(1);
  });

  it('负例（故障注入）：一步抛错不影响其余五步，且日志指名道姓', async () => {
    shutdownPostHog.mockRejectedValueOnce(new Error('posthog boom'));
    const lines: string[] = [];

    await expect(runShutdownFinalizers(1_000, (msg) => lines.push(msg))).resolves.toBeUndefined();

    expect(lines[0]).toContain('posthog.flush=failed(posthog boom)');
    for (const label of ALL_LABELS.filter((l) => l !== 'posthog.flush')) {
      expect(lines[0]).toContain(`${label}=ok(`);
    }
    // 其余五步真的跑了，不是被短路掉
    expect(disconnectAll).toHaveBeenCalledTimes(1);
    expect(disposeAgentRegistry).toHaveBeenCalledTimes(1);
    expect(stopRateLimitCleanupTimer).toHaveBeenCalledTimes(1);
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

  it('companion 停机挂死（keytar 弹框）时后续步骤照跑，关库轮得到', async () => {
    // lan.stop() 会 await 还在飞的 restore()，而 restore() 可能正卡在
    // keytar.getPassword 上等用户点钥匙串授权框——那是一个没有上限的等待。
    // 它一旦不被 withCap 封顶，下面两步一步都轮不到，Rust 侧到点就 SIGKILL。
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { withCap } = createShutdownStepCap(60);
    const ran: string[] = [];

    await withCap(new Promise<void>(() => {}), 'companion.stop');
    await withCap((async () => { ran.push('reapChildProcesses'); })(), 'reapChildProcesses');
    ran.push('closeAllDatabaseConnections');

    expect(warn).toHaveBeenCalledWith('[shutdown] companion.stop timed out, skipping');
    expect(ran).toEqual(['reapChildProcesses', 'closeAllDatabaseConnections']);
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

  it('companion 停机排在预算创建之后并经 withCap 封顶——它是唯一会弹系统授权框的 pre-close 步骤', () => {
    const capCreated = source.indexOf('createShutdownStepCap()');
    const companion = source.indexOf('stopCompanion?.()');
    const closeDb = source.indexOf('closeAllDatabaseConnections()');

    expect(companion).toBeGreaterThan(-1);
    // 排在 cap 之前 = 预算时钟根本没起跑，之后每一步的封顶都是空头支票
    expect(companion).toBeGreaterThan(capCreated);
    expect(companion).toBeLessThan(closeDb);
    // 光排在后面不够，必须真被封顶：裸 await 一个可能永不 resolve 的 promise 等于没预算
    expect(source).toMatch(/withCap\(\s*\n\s*stopCompanion\?\.\(\)[\s\S]{0,240}?'companion\.stop'/);
  });

  it('死文件 src/host/app/lifecycle.ts 已删，责任不再有第二个账本', () => {
    expect(() =>
      readFileSync(join(process.cwd(), 'src/host/app/lifecycle.ts'), 'utf-8'),
    ).toThrow();
  });

  it('N-SHUTDOWN-DEADLINK：四处清理不再挂从没跑过的 onShutdown 死表', () => {
    // 那张表的 setupDefaultSignalHandlers 零调用方，挂上去等于换个地方继续死
    // （terminalSessionManager 同款守护）。清理必须走 webShutdownFinalizers 活停机序列。
    for (const file of [
      'src/host/tools/shell/ptyExecutor.ts',
      'src/host/tools/shell/backgroundTasks.ts',
      'src/host/ipc/connector.ipc.ts',
      'src/web/middleware/auth.ts',
    ]) {
      const source = readFileSync(join(process.cwd(), file), 'utf-8');
      expect(source, `${file} 又挂回了 onShutdown 死表`).not.toContain('onShutdown(');
    }
  });

  it('N-SHUTDOWN-DEADLINK：死注册表 gracefulShutdown.ts 整文件已删（含 setupDefaultSignalHandlers）', () => {
    // 信号注册面的完整守护在 shutdownSignalOwnership.static.test.ts（带白名单）；
    // 这里锚文件级删除——onShutdown 表的 setupDefaultSignalHandlers 零调用方，
    // 四处注册迁活停机后整文件死透（同 lifecycle.ts 先例：责任不再有第二个账本）。
    expect(() =>
      readFileSync(join(process.cwd(), 'src/host/services/infra/gracefulShutdown.ts'), 'utf-8'),
    ).toThrow();
  });
});
