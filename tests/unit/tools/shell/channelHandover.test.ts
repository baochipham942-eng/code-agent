// Rework r2 ①②④ 收口回归：channel 源会话（真实 sessionManager.createSession 建档，
// 因此同时 unattended + short-tier）里，前台命令过短档即走**真实** handover 收编成
// 后台任务（不 mock timeoutHandover / backgroundTasks），会话下一步不被收编任务挡住，
// 任务终态经真实 lifecycle 适配器 → backgroundTaskLedger 以 TaskNotification 回流该会话。
// 证据档位：real-runtime（真实子进程 + 真实收编/台账/适配器；仅 db 与重描述等重件被 mock）。
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext, CanUseToolFn, Logger } from '../../../../src/host/protocol/tools';

// -----------------------------------------------------------------------------
// 与 bash.test.ts 同款的轻量隔离 mock（重描述/指纹/codex/命令安全/PATH 诊断）
// 关键差异：backgroundTasks / timeoutHandover / foregroundCommand / 台账 / 适配器全部真实。
// -----------------------------------------------------------------------------
vi.mock('../../../../src/host/tools/shell/dynamicDescription', () => ({
  generateBashDescription: () => Promise.resolve(null),
}));

vi.mock('../../../../src/host/tools/dataFingerprint', () => ({
  extractBashFacts: () => null,
  dataFingerprintStore: { recordFact: () => {} },
}));

vi.mock('../../../../src/host/services/codex/codexSandbox', () => ({
  isCodexSandboxEnabled: () => false,
  runInCodexSandbox: () => Promise.resolve({ success: false }),
}));

vi.mock('../../../../src/host/security/commandSafety', () => ({
  isKnownSafeCommand: () => true,
}));

vi.mock('../../../../src/host/services/infra/shellEnvironment', () => ({
  getShellPathDiagnostics: () => ({
    path: process.env.PATH || '',
    source: 'process',
    pathEntryCount: (process.env.PATH || '').split(':').filter(Boolean).length,
    degraded: false,
    fallbackApplied: false,
    fallbackEntries: [],
  }),
}));

// sessionManager.createSession 只需要 db.createSession / logAuditEvent 两个落盘点。
const createSessionRow = vi.fn();
vi.mock('../../../../src/host/services/core', () => ({
  getDatabase: () => ({ createSession: createSessionRow, logAuditEvent: vi.fn() }),
}));
vi.mock('../../../../src/host/services/project/projectService', () => ({
  getProjectService: () => ({ ensureProjectForWorkspace: async () => ({ id: 'proj-1' }) }),
}));

// OS 沙箱包装透传（与 bash.test.ts 同款）：unattended 会话强制 wrap，真 seatbelt/bwrap
// 的跨平台差异由 tests/integration/sandbox 覆盖；本文件验证的是收编/回流链路。
// 透传不改变执行语义，收编任务继承的就是这条命令。
const { wrapMock, cleanupMock } = vi.hoisted(() => {
  process.env.OS_SANDBOX_ENABLED = 'true';
  return { wrapMock: vi.fn(), cleanupMock: vi.fn() };
});
vi.mock('../../../../src/host/sandbox', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../src/host/sandbox')>()),
  wrapCommandForSandbox: (...args: unknown[]) => wrapMock(...args),
}));

import { bashModule } from '../../../../src/host/tools/modules/shell/bash';
import { getSessionManager } from '../../../../src/host/services/infra/sessionManager';
import { getPermissionModeManager } from '../../../../src/host/permissions/modes';
import { resolveForegroundTimeoutTier } from '../../../../src/host/tools/shell/foregroundTier';
import { BackgroundTaskLedger } from '../../../../src/host/task/backgroundTaskLedger';
import { installBackgroundTaskEventAdapters } from '../../../../src/host/task/backgroundTaskSnapshotAdapters';
import {
  adoptBackgroundTask,
  getAllBackgroundTasks,
  killBackgroundTask,
} from '../../../../src/host/tools/shell/backgroundTasks';

function makeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeCtx(sessionId: string): ToolContext {
  return {
    sessionId,
    workingDir: process.cwd(),
    abortSignal: new AbortController().signal,
    logger: makeLogger(),
    emit: () => void 0,
    policyEnforcer: null,
  };
}

const allowAll: CanUseToolFn = async () => ({ allow: true });

const posixOnly = process.platform === 'win32' ? describe.skip : describe;

posixOnly('channel 会话短档超时 handover（真实建档/真实收编）', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'neo-channel-handover-'));
  const adoptedTaskIds: string[] = [];
  let prevTierEnv: string | undefined;
  let detachAdapters: (() => void) | null = null;

  beforeEach(() => {
    prevTierEnv = process.env.CODE_AGENT_BASH_SHORT_TIMEOUT_MS;
    process.env.CODE_AGENT_BASH_SHORT_TIMEOUT_MS = '250';
    vi.clearAllMocks();
    wrapMock.mockImplementation((cmd: unknown) => ({ command: cmd, cleanup: cleanupMock }));
  });

  afterEach(async () => {
    if (prevTierEnv === undefined) delete process.env.CODE_AGENT_BASH_SHORT_TIMEOUT_MS;
    else process.env.CODE_AGENT_BASH_SHORT_TIMEOUT_MS = prevTierEnv;
    detachAdapters?.();
    detachAdapters = null;
    for (const taskId of adoptedTaskIds.splice(0)) {
      await killBackgroundTask(taskId).catch(() => undefined);
    }
    vi.useRealTimers();
  });

  async function createChannelSession(): Promise<string> {
    const session = await getSessionManager().createSession({
      title: 'channel-handover-test',
      modelConfig: {} as never,
      workingDirectory: cwd,
      origin: { kind: 'channel', id: 'acc-1', name: 'feishu-test' },
    });
    // 真实建档即双标记：channel 源 → unattended + short tier（sessionManager 单点收口）。
    expect(getPermissionModeManager().isUnattendedSession(session.id)).toBe(true);
    expect(resolveForegroundTimeoutTier(session.id)).toBe('short');
    return session.id;
  }

  it('①②④ 超短档命令转后台带回 task-id，下一条入站立刻有回应，终态结果经 TaskNotification 回流', async () => {
    const sessionId = await createChannelSession();
    const ledger = new BackgroundTaskLedger();
    detachAdapters = installBackgroundTaskEventAdapters(ledger);
    const handler = await bashModule.createHandler();
    const ctx = makeCtx(sessionId);

    // 入站长命令：tier 250ms，命令本身 ~1.2s。node 开头不触发 no-wait 守卫。
    const t0 = Date.now();
    const longRun = await handler.execute(
      { command: "node -e \"setTimeout(() => console.log('channel-done'), 1200)\"" },
      ctx,
      allowAll,
    );
    const toolElapsed = Date.now() - t0;
    expect(longRun.ok).toBe(true);
    if (!longRun.ok) return;
    expect(longRun.output).toContain('was adopted as a background task');
    expect(longRun.output).toContain('Reply to the user now; do not wait or poll.');
    expect(longRun.output).not.toContain('Process with action');
    const taskId = longRun.output.match(/<task-id>([^<]+)<\/task-id>/)?.[1];
    expect(taskId).toBeTruthy();
    adoptedTaskIds.push(taskId!);
    // 工具在命令自然结束前就返回（~250ms 档位，而非等满 1.2s）。
    expect(toolElapsed).toBeLessThan(1100);
    // 收编任务真实在跑，属于该会话。
    expect(getAllBackgroundTasks().find((task) => task.taskId === taskId)).toMatchObject({
      status: 'running',
      sessionId,
    });

    // 下一条入站消息立即有回应：同一会话、收编任务仍在跑时执行，不被它挡住。
    const t1 = Date.now();
    const next = await handler.execute({ command: 'echo next-inbound-ok' }, ctx, allowAll);
    expect(next.ok).toBe(true);
    if (next.ok) expect(next.output).toContain('next-inbound-ok');
    expect(Date.now() - t1).toBeLessThan(1000);

    // 结果稍后回流：真实进程退出 → lifecycle completed → 适配器 → 该会话的 TaskNotification。
    let drained: ReturnType<BackgroundTaskLedger['drainNotifications']> = [];
    await vi.waitFor(() => {
      drained = ledger.drainNotifications(sessionId);
      expect(drained.length).toBeGreaterThan(0);
    }, { timeout: 6000, interval: 100 });
    expect(drained[0]).toMatchObject({
      taskId: `shell:${taskId}`,
      type: 'task_completed',
    });
    expect(ledger.getTask(`shell:${taskId}`)).toMatchObject({ status: 'completed' });
  }, 15_000);

  it('② N-BGTASK-HANG-TERMINAL 终态兜底覆盖 unattended 会话的收编任务：过 maxRuntime 被终止并回流失败通知', async () => {
    const sessionId = await createChannelSession();
    const ledger = new BackgroundTaskLedger();
    detachAdapters = installBackgroundTaskEventAdapters(ledger);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    // 直接收编一个真睡 60s 的子进程（与 timeoutHandover 同一条 adopt 路径）。
    const child = spawn('sleep', ['60'], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    child.unref();
    const adopted = adoptBackgroundTask(child, 'sleep 60', cwd, {
      sessionId,
      startedAt: Date.now(),
    });
    expect(adopted.success).toBe(true);
    adoptedTaskIds.push(adopted.taskId!);

    // 推进假时钟越过 BACKGROUND_TASK_MAX_RUNTIME（10min）：挂死任务被终止 → 终态 → 通知。
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 1_000);
    // kill 是真异步（SIGTERM + 轮询探活），close 事件要等真事件循环落地：切回真钟等终态。
    vi.useRealTimers();
    await vi.waitFor(() => {
      const task = getAllBackgroundTasks().find((entry) => entry.taskId === adopted.taskId);
      expect(task?.status === 'failed' || task?.status === 'completed').toBe(true);
    }, { timeout: 6000, interval: 50 });

    const ledgerTask = ledger.getTask(`shell:${adopted.taskId}`);
    expect(ledgerTask?.status === 'failed' || ledgerTask?.status === 'completed').toBe(true);
    const drained = ledger.drainNotifications(sessionId);
    expect(drained.length).toBeGreaterThan(0);
    expect(drained[0]).toMatchObject({
      taskId: `shell:${adopted.taskId}`,
      sessionId,
    });
  }, 15_000);
});
