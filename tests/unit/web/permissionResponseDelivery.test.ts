// ============================================================================
// 审批响应投递链路（web 路径）——2026-07-26 真机「点允许点不动」的回归门
// ============================================================================
//
// 判据一律是**真实行为**：等在 requestPermission 上的那个 Promise 到底有没有被放行，
// 而不是「某个函数有没有被调到」。真 TaskManager + 真 AgentOrchestrator + 真登记路径，
// 只有 configService 是 stub。
//
// 真因回顾：web 路径原本把这个 channel 转发给 agent.ipc.ts 的 legacy handler，
// 而 webServer 给它的 `getAppService()` 恒为 null ⇒ 生产上必抛 "Agent not initialized"。
// 第 5 个用例专门钉这一点：Map 里预置一个「一被调到就抛」的旧 handler，安装后必须绕开它。

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { installPermissionResponseHandler } from '../../../src/web/webPermissionResponseHandler';
import { initTaskManager, type TaskManager } from '../../../src/host/task/TaskManager';
import { IPC_CHANNELS } from '../../../src/shared/ipc';
import type { AgentOrchestrator } from '../../../src/host/agent/agentOrchestrator';
import type { PendingDevPermissionRequest } from '../../../src/web/routes/dev';

type Handler = (event: unknown, ...args: unknown[]) => unknown | Promise<unknown>;
type IpcResult = { success: boolean; data?: unknown; error?: { code: string; message: string } };

const configServiceStub = {
  getSettings: () => ({
    permissions: {
      autoApprove: { read: true, write: false, execute: false, network: false },
      devModeAutoApprove: false,
    },
    models: { default: 'openai', providers: {}, routing: {} },
  }),
  getApiKey: () => '',
  getServiceApiKey: () => '',
};

/**
 * 从 ToolExecutor 取构造时注入的生产登记入口；它实际绑定到
 * OrchestratorPermissionIsland.requestPermission，而非已经搬走的 orchestrator 方法。
 */
function requestPermission(orchestrator: AgentOrchestrator): (request: Record<string, unknown>) => Promise<boolean> {
  return (orchestrator as unknown as {
    toolExecutor: { requestPermission: (request: Record<string, unknown>) => Promise<boolean> };
  }).toolExecutor.requestPermission;
}

/** 拿到权限岛内部的真实挂起表；登记仍必须经 ToolExecutor 注入的生产入口。 */
function pendingIds(orchestrator: AgentOrchestrator): string[] {
  return [...(orchestrator as unknown as {
    permissions: { pendingPermissions: Map<string, unknown> };
  }).permissions.pendingPermissions.keys()];
}

describe('审批响应投递链路（web 路径）', () => {
  let handlers: Map<string, Handler>;
  let pendingDevPermissions: Map<string, PendingDevPermissionRequest>;
  type LogFn = ReturnType<typeof vi.fn<(message: string, ...args: unknown[]) => void>>;
  let logger: { info: LogFn; warn: LogFn };
  let taskManager: TaskManager;
  let currentSessionId: string | null;

  const install = () =>
    installPermissionResponseHandler({
      handlers,
      pendingDevPermissions,
      getCurrentSessionId: () => currentSessionId,
      logger,
    });

  const invoke = (requestId: string, response: string, sessionId?: string) =>
    handlers.get(IPC_CHANNELS.AGENT_PERMISSION_RESPONSE)!(null, requestId, response, sessionId) as Promise<IpcResult>;

  const warnText = () => JSON.stringify(logger.warn.mock.calls);

  beforeEach(() => {
    // 测试环境默认开着 AUTO_TEST（requestPermission 会直接放行），本套件要的正是真实审批等待
    vi.stubEnv('AUTO_TEST', '');
    handlers = new Map();
    pendingDevPermissions = new Map();
    logger = { info: vi.fn(), warn: vi.fn() };
    currentSessionId = null;
    taskManager = initTaskManager();
    taskManager.initialize({
      configService: configServiceStub as never,
      onAgentEvent: () => {},
    } as never);
  });

  it('点「允许」真的放行了等在 requestPermission 上的工具调用', async () => {
    const sessionId = 'sess-live';
    const orchestrator = taskManager.getOrCreateCurrentOrchestrator(sessionId)!;
    install();

    // 走 ToolExecutor 实际持有的生产登记入口：它自己登记并返回等待中的 Promise
    const approval = requestPermission(orchestrator)({ type: 'file_write', tool: 'Write', sessionId, reason: 'gate' });
    await Promise.resolve();

    const [requestId] = pendingIds(orchestrator);
    expect(requestId).toBeTruthy();

    const result = await invoke(requestId, 'allow', sessionId);
    expect(result.success).toBe(true);
    // 真实行为判据：工具那一侧拿到了 true，而不是「handler 被调用过」
    await expect(approval).resolves.toBe(true);
  });

  it('拒绝也真的传到了工具那一侧', async () => {
    const sessionId = 'sess-deny';
    const orchestrator = taskManager.getOrCreateCurrentOrchestrator(sessionId)!;
    install();

    const approval = requestPermission(orchestrator)({ type: 'command', tool: 'Bash', sessionId, reason: 'gate' });
    await Promise.resolve();

    const [requestId] = pendingIds(orchestrator);
    await invoke(requestId, 'deny', sessionId);
    await expect(approval).resolves.toBe(false);
  });

  it('不存在的 requestId：报 PENDING_PERMISSION_NOT_FOUND，且日志指名道姓', async () => {
    const sessionId = 'sess-unknown-req';
    taskManager.getOrCreateCurrentOrchestrator(sessionId);
    install();

    const result = await invoke('no-such-request', 'allow', sessionId);
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('PENDING_PERMISSION_NOT_FOUND');
    expect(warnText()).toContain('no-such-request');
  });

  it('该会话没有活跃 orchestrator：报 NO_ACTIVE_ORCHESTRATOR，日志同时点名 requestId 与 sessionId', async () => {
    install();

    const result = await invoke('req-x', 'allow', 'sess-never-started');
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('NO_ACTIVE_ORCHESTRATOR');
    const text = warnText();
    expect(text).toContain('req-x');
    expect(text).toContain('sess-never-started');
  });

  it('没带 sessionId 且没有当前会话：报 NO_ACTIVE_SESSION 而不是静默成功', async () => {
    install();

    const result = await invoke('req-y', 'allow');
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('NO_ACTIVE_SESSION');
    expect(warnText()).toContain('req-y');
  });

  it('绝不再委派给走 AppService 的 legacy handler（web 模式下 AppService 恒为 null）', async () => {
    const sessionId = 'sess-no-delegate';
    const orchestrator = taskManager.getOrCreateCurrentOrchestrator(sessionId)!;
    // 模拟 agent.ipc.ts 在 web 依赖下的行为：一被调到就抛，这就是生产上那条 500
    handlers.set(IPC_CHANNELS.AGENT_PERMISSION_RESPONSE, () => {
      throw new Error('Agent not initialized');
    });
    install();

    const approval = requestPermission(orchestrator)({ type: 'file_write', tool: 'Write', sessionId, reason: 'gate' });
    await Promise.resolve();

    const [requestId] = pendingIds(orchestrator);
    await expect(invoke(requestId, 'allow', sessionId)).resolves.toMatchObject({ success: true });
    await expect(approval).resolves.toBe(true);
  });

  it('dev 审批（/api/dev 真审批）仍走原来的 pendingDevPermissions 出口', async () => {
    install();
    const resolve = vi.fn();
    pendingDevPermissions.set('dev-req', {
      request: { sessionId: 'sess-dev' },
      resolve,
      reject: vi.fn(),
      timer: setTimeout(() => {}, 0),
    } as unknown as PendingDevPermissionRequest);

    const result = await invoke('dev-req', 'allow');
    expect(result.success).toBe(true);
    expect(resolve).toHaveBeenCalledWith('allow');
  });
});
