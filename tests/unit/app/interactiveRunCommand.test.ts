// ============================================================================
// runInteractiveCommand（!run 按钮的 host 执行入口）行为级测试
// ----------------------------------------------------------------------------
// 真 ToolExecutor + 真 Bash 工具（真 protocol registry）+ 真 AgentOrchestrator /
// OrchestratorPermissionIsland（经 TaskManager 创建，只有 configService 是 stub）。
// 不出网、不调付费模型：dynamicDescription（LLM）mock 为 null，权限分类器走真规则
// （LLM 分类器默认关），exec policy store mock 为空表保证 hermetic。
// 进程生成边界（foregroundCommand）用透传 recorder 捕获——真进程照常跑。
//
// 布局注意：run 的 Promise 必须在用例体内直接创建，flush 只做等待——包一层
// `async function start() { const run = ...; await flush(); return run; }` 会把整条
// await 链挪进 helper 的微任务上下文，setImmediate 泵不再前进（同文件内实证：
// inline 形态绿、helper 形态 30s 挂死），别改回 helper 包裹。
// ============================================================================

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// LLM 动态描述：并行发起真实模型调用，测试里必须掐掉（不出网、不付费）。
vi.mock('../../../src/host/tools/shell/dynamicDescription', () => ({
  generateBashDescription: async () => null,
}));

// exec policy：真表会读用户的 exec-policy.json 且审批后会学习写回——hermetic 起见
// 换空表（与 toolExecutor.peerOrigin.test.ts 同款）。
vi.mock('../../../src/host/security', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../src/host/security')>();
  return {
    ...original,
    getExecPolicyStore: () => ({
      match: (cmd: string) => harness.execPolicyMatch(cmd),
      learnFromApproval: () => false,
    }),
  };
});

// OS 沙箱 wrap：默认透传真实现（真 seatbelt 照常生效），test d 切成抛错制造
// 「沙箱强制但不可用」（bash.test.ts 的 wrapMock 同款夹具，方向反过来）。
vi.mock('../../../src/host/sandbox', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../src/host/sandbox')>();
  return {
    ...original,
    wrapCommandForSandbox: (...args: Parameters<typeof original.wrapCommandForSandbox>) =>
      (harness.wrapImpl ? harness.wrapImpl(...args) : original.wrapCommandForSandbox(...args)),
  };
});

// 进程生成边界 recorder：记录交给 shell 的命令串与 cwd，然后照常真跑。
vi.mock('../../../src/host/tools/modules/shell/foregroundCommand', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../src/host/tools/modules/shell/foregroundCommand')>();
  return {
    ...original,
    runForegroundCommand: (options: Parameters<typeof original.runForegroundCommand>[0]) => {
      harness.spawnCalls.push({ command: options.command, cwd: options.cwd });
      return original.runForegroundCommand(options);
    },
  };
});

import { runInteractiveCommand } from '../../../src/host/app/interactiveRunCommand';
import { getTaskManager, initTaskManager, resetTaskManager } from '../../../src/host/task/TaskManager';
import { getPermissionModeManager, resetPermissionModeManager } from '../../../src/host/permissions/modes';
import { getProtocolRegistry } from '../../../src/host/tools/protocolRegistry';
import { getToolCache } from '../../../src/host/services/infra/toolCache';
import { resetPolicyEnforcer } from '../../../src/host/security/policyEnforcer';
import { getPolicyEngine, resetPolicyEngine } from '../../../src/host/permissions/policyEngine';
import type { ConfigService } from '../../../src/host/services/core/configService';
import type { AgentEvent, PermissionRequest } from '../../../src/shared/contract';
import type { AgentOrchestrator } from '../../../src/host/agent/agentOrchestrator';

const harness = vi.hoisted(() => ({
  devModeAutoApprove: false,
  autoApproveExecute: false,
  execPolicyMatch: (_cmd: string): 'allow' | 'prompt' | 'forbidden' | null => null,
  wrapImpl: null as null | ((...args: unknown[]) => { command: string; cleanup: () => void }),
  spawnCalls: [] as Array<{ command: string; cwd: string }>,
}));

function permissionCards(events: AgentEvent[]): PermissionRequest[] {
  return events.flatMap((event) => (event.type === 'permission_request' ? [event.data] : []));
}

/**
 * 事件泵：只等待、不包 run。默认 setImmediate（真实 fs I/O 要在迭代间落地，纯
 * nextTick 链会饿死事件循环的 poll 阶段）；假时钟用例传 advanceTimersByTimeAsync 泵。
 */
async function flushUntil(
  predicate: () => boolean,
  label: string,
  pump: () => Promise<unknown> = () => new Promise<void>((resolve) => setImmediate(resolve)),
  maxTicks = 2000,
): Promise<void> {
  for (let i = 0; i < maxTicks && !predicate(); i += 1) {
    await pump();
  }
  if (!predicate()) throw new Error(`flushUntil: ${label} not reached`);
}

describe('runInteractiveCommand（!run 按钮 host 入口）', () => {
  let workspace: string;
  let events: AgentEvent[];
  let orchestrator: AgentOrchestrator;
  let currentSession: string;
  let sid = 0;

  beforeAll(() => {
    getProtocolRegistry();
  });

  beforeEach(() => {
    harness.devModeAutoApprove = false;
    harness.autoApproveExecute = false;
    harness.execPolicyMatch = () => null;
    harness.wrapImpl = null;
    harness.spawnCalls.length = 0;
    events = [];
    resetPermissionModeManager();
    resetPolicyEnforcer();
    resetPolicyEngine();
    getPolicyEngine();
    getToolCache().clear();
    process.env.CODE_AGENT_SHELL_SAFETY_MODE = 'strict';
    const configService = {
      getSettings: () => ({
        permissions: {
          autoApprove: { read: false, write: false, execute: harness.autoApproveExecute, network: false },
          devModeAutoApprove: harness.devModeAutoApprove,
        },
      }),
      isDevModeAutoApproveEnabled: () => harness.devModeAutoApprove,
    } as unknown as ConfigService;
    const taskManager = initTaskManager();
    taskManager.initialize({
      configService: configService as never,
      onAgentEvent: (_sessionId: string, event: AgentEvent) => { events.push(event); },
    } as never);
    currentSession = `iact-run-${++sid}`;
    orchestrator = getTaskManager().getOrCreateCurrentOrchestrator(currentSession)!;
    workspace = '';
  });

  afterEach(async () => {
    for (const pending of orchestrator?.getPendingPermissionRequests() ?? []) {
      orchestrator.handlePermissionResponse(pending.id, 'deny');
    }
    await orchestrator?.drainWorkspaceServices();
    if (workspace) await fs.rm(workspace, { recursive: true, force: true });
    resetTaskManager();
    resetPermissionModeManager();
    vi.unstubAllEnvs();
    delete process.env.CODE_AGENT_SHELL_SAFETY_MODE;
    vi.useRealTimers();
  });

  /** 每个用例自己的临时 cwd：会话 orchestrator 指到它，命令在它里面跑。 */
  async function prepareWorkspace(): Promise<string> {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'iact-run-exec-'));
    // syncWorkspaceServices:false — 别在单测里点火 LSP/skillWatcher 链（会拉起真语言服务器）。
    orchestrator.setWorkingDirectory(workspace, { syncWorkspaceServices: false });
    return workspace;
  }

  function sessionId(): string {
    return currentSession;
  }

  it('(a) 审批串与执行串逐字节等于 payload（引号/中文/冒号/括号/尾随空格），命令真跑完', async () => {
    const cwd = await prepareWorkspace();
    // 尾随空格在 payload 里：审批卡与 shell 都必须原样收到它。
    const payload = `printf '%s' '中文: (括号) "双引号" 单引号' `;
    const expected = '中文: (括号) "双引号" 单引号';
    // 关沙箱（紧急刹车档）让生成边界确定性收到裸 payload；沙箱路径由 (b)/(d) 覆盖。
    vi.stubEnv('OS_SANDBOX_ENABLED', 'false');

    const run = runInteractiveCommand({ sessionId: sessionId(), command: payload });
    await flushUntil(() => orchestrator.getPendingPermissionRequests().length > 0, 'permission card');
    const cards = orchestrator.getPendingPermissionRequests();
    expect(cards).toHaveLength(1);
    expect(cards[0]!.details.command).toBe(payload);
    expect(cards[0]!.forceConfirm).toBe(true);
    expect(cards[0]!.type).toBe('command');
    orchestrator.handlePermissionResponse(cards[0]!.id, 'allow');

    const result = await run;
    expect(result.status).toBe('completed');
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain(expected);
    expect(harness.spawnCalls).toHaveLength(1);
    expect(harness.spawnCalls[0]!.command).toBe(payload);
    // macOS 的 /var 是 /private/var 的符号链接，Bash 工具按 canonical path 执行。
    expect(harness.spawnCalls[0]!.cwd).toBe(await fs.realpath(cwd));
  });

  it('(b) bypassPermissions + devModeAutoApprove + autoApprove.execute 仍必须真人确认，确认前不跑', async () => {
    await prepareWorkspace();
    harness.devModeAutoApprove = true;
    harness.autoApproveExecute = true;
    expect(getPermissionModeManager().setSessionMode(sessionId(), 'bypassPermissions', true)).toBe(true);
    const payload = `printf '%s' 'bypass-ok'`;

    const run = runInteractiveCommand({ sessionId: sessionId(), command: payload });
    await flushUntil(() => orchestrator.getPendingPermissionRequests().length > 0, 'permission card');
    // 自动放行全部让路：卡已出、进程没跑、结果未定。
    const cards = orchestrator.getPendingPermissionRequests();
    expect(cards).toHaveLength(1);
    expect(cards[0]!.details.command).toBe(payload);
    expect(cards[0]!.forceConfirm).toBe(true);
    expect(harness.spawnCalls).toHaveLength(0);
    const pending = Symbol('pending');
    expect(await Promise.race([run.then(() => 'settled'), Promise.resolve(pending)])).toBe(pending);

    orchestrator.handlePermissionResponse(cards[0]!.id, 'allow');
    const result = await run;
    expect(result.status).toBe('completed');
    expect(result.output).toContain('bypass-ok');
    expect(harness.spawnCalls).toHaveLength(1);
  });

  it('(c) 硬毙命令在出卡之前被拒：审批链一次都没被叫到', async () => {
    await prepareWorkspace();
    const payload = ':(){ :|:& };:';

    const result = await runInteractiveCommand({ sessionId: sessionId(), command: payload });

    expect(result.status).toBe('refused');
    expect(result.reason).toContain('Security: Command blocked');
    expect(orchestrator.getPendingPermissionRequests()).toHaveLength(0);
    expect(permissionCards(events)).toHaveLength(0);
    expect(harness.spawnCalls).toHaveLength(0);
  });

  it('(d) 沙箱强制但不可用：原文上报 refused，绝不摘沙箱重试', async () => {
    await prepareWorkspace();
    expect(getPermissionModeManager().setSessionMode(sessionId(), 'bypassPermissions', true)).toBe(true);
    // bypass + 显式 opt-in = 严格档：wrap 失败不许降级。wrap 切成抛错制造不可用。
    vi.stubEnv('OS_SANDBOX_ENABLED', 'true');
    harness.wrapImpl = (() => {
      throw new Error('seatbelt fixture unavailable');
    }) as unknown as typeof harness.wrapImpl;

    const run = runInteractiveCommand({ sessionId: sessionId(), command: `printf '%s' 'never'` });
    await flushUntil(() => orchestrator.getPendingPermissionRequests().length > 0, 'permission card');
    const cards = orchestrator.getPendingPermissionRequests();
    expect(cards).toHaveLength(1);
    orchestrator.handlePermissionResponse(cards[0]!.id, 'allow');

    const result = await run;
    expect(result.status).toBe('refused');
    expect(result.reason).toContain('OS sandbox is required but unavailable');
    expect(result.reason).toContain('seatbelt fixture unavailable');
    expect(harness.spawnCalls).toHaveLength(0);
  });

  it('(e1) 真人点拒绝 → denied，进程从未生成', async () => {
    await prepareWorkspace();
    const payload = `printf '%s' 'nope'`;

    const run = runInteractiveCommand({ sessionId: sessionId(), command: payload });
    await flushUntil(() => orchestrator.getPendingPermissionRequests().length > 0, 'permission card');
    const cards = orchestrator.getPendingPermissionRequests();
    expect(cards).toHaveLength(1);
    orchestrator.handlePermissionResponse(cards[0]!.id, 'deny');

    const result = await run;
    expect(result.status).toBe('denied');
    expect(result.reason).toContain('Permission denied by user');
    expect(harness.spawnCalls).toHaveLength(0);
  });

  it('(e2) 无审批面且无人应答 → 超时 fail-closed → denied，进程从未生成', async () => {
    vi.useFakeTimers();
    await prepareWorkspace();

    const run = runInteractiveCommand({ sessionId: sessionId(), command: `printf '%s' 'never'` });
    // 假时钟下 setImmediate 也被接管：泵改用 advanceTimersByTimeAsync（顺带清微任务）。
    await flushUntil(
      () => orchestrator.getPendingPermissionRequests().length > 0,
      'permission card',
      () => vi.advanceTimersByTimeAsync(1),
    );
    // hasApprovalUi 在测试态为 false（electron mock 无窗口）：60s 交互门走完 → timeout。
    await vi.advanceTimersByTimeAsync(75_000);

    const result = await run;
    expect(result.status).toBe('denied');
    expect(result.reason).toContain('超时');
    expect(harness.spawnCalls).toHaveLength(0);
  });

  it('(f) 审批卡带 updatedArgs 应答：改参被丢弃，执行的仍是 payload', async () => {
    await prepareWorkspace();
    const payload = `printf '%s' 'payload-f'`;
    // 与 (a) 同款沙箱刹车：这里验证的是改参被丢，生成边界要拿到裸 payload 才好比对。
    vi.stubEnv('OS_SANDBOX_ENABLED', 'false');

    const run = runInteractiveCommand({ sessionId: sessionId(), command: payload });
    await flushUntil(() => orchestrator.getPendingPermissionRequests().length > 0, 'permission card');
    const cards = orchestrator.getPendingPermissionRequests();
    expect(cards).toHaveLength(1);
    orchestrator.handlePermissionResponse(cards[0]!.id, 'allow', { command: `printf '%s' 'tampered'` });

    const result = await run;
    expect(result.status).toBe('completed');
    expect(result.output).toContain('payload-f');
    expect(result.output).not.toContain('tampered');
    expect(harness.spawnCalls).toHaveLength(1);
    expect(harness.spawnCalls[0]!.command).toBe(payload);
  });

  it('(4) 非法入参与无 orchestrator 都 refused，且零审批零进程', async () => {
    const empty = await runInteractiveCommand({ sessionId: 's-x', command: '' });
    expect(empty).toMatchObject({ status: 'refused', output: '' });
    expect(empty.reason).toContain('non-empty');

    const noSession = await runInteractiveCommand({ sessionId: '', command: 'true' });
    expect(noSession.status).toBe('refused');
    expect(noSession.reason).toContain('sessionId');

    // TaskManager 未初始化（无 configService/onAgentEvent）→ 会话解析不出 orchestrator。
    resetTaskManager();
    const noOrchestrator = await runInteractiveCommand({ sessionId: 's-unknown', command: 'true' });
    expect(noOrchestrator.status).toBe('refused');
    expect(noOrchestrator.reason).toContain('no orchestrator');

    expect(orchestrator.getPendingPermissionRequests()).toHaveLength(0);
    expect(harness.spawnCalls).toHaveLength(0);
  });
});
