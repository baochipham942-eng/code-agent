// ============================================================================
// 批 6 · B6a：StandaloneAgentAdapter 审批门决策注入
// ============================================================================
// eval 真模型路径此前把 requestPermission 写死 async () => true（全自动放行），
// 审批门在 eval 里不可测。本批改为：case 配了 user_simulation.permission_policy
// 时按策略应答，未配置时保持原样（存量 eval 行为零变化）。
// ============================================================================

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StandaloneAgentAdapter } from '../../../src/host/testing/agentAdapter';
import type { PermissionRequestData } from '../../../src/host/tools/types';
import type { RequestPermissionResult } from '../../../src/shared/contract/permission';

const capturedPermissionHandlers: Array<(
  req: PermissionRequestData,
) => Promise<RequestPermissionResult>> = [];
const capturedForcePermissionHandler: boolean[] = [];

vi.mock('../../../src/host/agent/agentLoop', () => ({
  AgentLoop: class {
    constructor(_config: unknown) {}
    async run(): Promise<void> { /* no-op */ }
  },
}));

vi.mock('../../../src/host/prompts/builder', () => ({
  SYSTEM_PROMPT: 'test system prompt',
}));

vi.mock('../../../src/host/tools/toolExecutor', () => ({
  ToolExecutor: class {
    constructor(config: {
      requestPermission: (req: PermissionRequestData) => Promise<RequestPermissionResult>;
      forcePermissionHandler?: boolean;
    }) {
      capturedPermissionHandlers.push(config.requestPermission);
      capturedForcePermissionHandler.push(config.forcePermissionHandler === true);
    }
  },
}));

vi.mock('../../../src/host/telemetry', () => ({
  getTelemetryCollector: () => ({
    startSession: vi.fn(),
    endSession: vi.fn(),
    handleEvent: vi.fn(),
    createAdapter: vi.fn(() => ({})),
  }),
}));

vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({ isReady: false }),
}));

function permissionRequest(tool: string, details: Record<string, unknown> = {}): PermissionRequestData {
  return { type: 'file_write', tool, details };
}

function makeAdapter(
  requestPermission?: (request: PermissionRequestData) => Promise<RequestPermissionResult>,
): StandaloneAgentAdapter {
  return new StandaloneAgentAdapter({
    workingDirectory: '/tmp',
    modelConfig: { provider: 'mock', model: 'mock-model' },
    requestPermission,
  });
}

beforeEach(() => {
  capturedPermissionHandlers.length = 0;
  capturedForcePermissionHandler.length = 0;
});

describe('StandaloneAgentAdapter permission policy injection', () => {
  it('defaults to auto-approve when no user_simulation configured (legacy eval behavior)', async () => {
    const adapter = makeAdapter();
    await adapter.sendMessage('hello');
    expect(capturedPermissionHandlers).toHaveLength(1);
    expect(capturedForcePermissionHandler).toEqual([false]);
    await expect(capturedPermissionHandlers[0](permissionRequest('Write'))).resolves.toBe(true);
  });

  it('uses an injected scripted policy before user simulation without an environment backdoor', async () => {
    const scripted = vi.fn(async () => ({
      approved: false,
      denialSource: 'scripted' as const,
    }));
    const adapter = makeAdapter(scripted);
    adapter.configureUserSimulation({
      permission_policy: 'approve',
      rules: [{ id: 'r', when: { question_asked: true }, respond: 'ok' }],
    });

    await adapter.sendMessage('hello');
    expect(capturedForcePermissionHandler).toEqual([true]);
    await expect(capturedPermissionHandlers[0](permissionRequest('Write'))).resolves.toEqual({
      approved: false,
      denialSource: 'scripted',
    });
    expect(scripted).toHaveBeenCalledOnce();
  });

  it('K5：scripted 策略在场时 case 的 reject 只做收窄——scripted 放行 + case 拒 ⇒ 以模拟用户身份拒（user，模型不会当成脚本故障重试），scripted 放行 + case 不拒 ⇒ 原样', async () => {
    const scripted = vi.fn(async () => ({ approved: true, approvalSource: 'scripted' as const }));
    const adapter = makeAdapter(scripted);
    adapter.configureUserSimulation({
      permission_policy: 'reject',
      permission_reject_commands: ['rm\\s+-[a-z]*r'],
      rules: [{ id: 'r', when: { question_asked: true }, respond: 'ok' }],
    });
    await adapter.sendMessage('hello');
    await expect(capturedPermissionHandlers[0](permissionRequest('Bash', { command: 'rm -rf casebank-rm-recursive' })))
      .resolves.toEqual({ approved: false, denialSource: 'user' });
    await expect(capturedPermissionHandlers[0](permissionRequest('Bash', { command: 'ls casebank-rm-recursive' })))
      .resolves.toEqual({ approved: true, approvalSource: 'scripted' });
    // N-EVAL-USERDENY-PRECEDENCE：case 命中时短路（rm 那次不再打扰 scripted），只有 ls 那次走到
    expect(scripted).toHaveBeenCalledTimes(1);
  });

  it('K5：scripted 已拒的请求不会被 case 的 approve 翻成放行（收窄不放宽）', async () => {
    const scripted = vi.fn(async () => ({ approved: false, denialSource: 'scripted' as const }));
    const adapter = makeAdapter(scripted);
    adapter.configureUserSimulation({
      permission_policy: 'approve',
      rules: [{ id: 'r', when: { question_asked: true }, respond: 'ok' }],
    });
    await adapter.sendMessage('hello');
    await expect(capturedPermissionHandlers[0](permissionRequest('Bash', { command: 'git push --force origin main' })))
      .resolves.toEqual({ approved: false, denialSource: 'scripted' });
  });

  it('N-EVAL-USERDENY-PRECEDENCE：case 拒优先于 scripted 判定——scripted 拒 + case 命中 ⇒ 以模拟用户身份拒（user）；scripted 拒 + case 未命中 ⇒ scripted 原样（文案不变）', async () => {
    const scripted = vi.fn(async () => ({ approved: false, denialSource: 'scripted' as const }));
    const adapter = makeAdapter(scripted);
    adapter.configureUserSimulation({
      permission_policy: 'reject',
      permission_reject_commands: ['\\bgit\\b[^\\n]*\\bpush\\b[^\\n]*(?:--force(?:-with-lease)?\\b|-f\\b)'],
      rules: [{ id: 'r', when: { question_asked: true }, respond: 'ok' }],
    });
    await adapter.sendMessage('hello');
    // scripted 拒 + case 命中 ⇒ user 拒（force-push 题的「模拟用户说不」自此生效，模型不会当脚本故障重试）
    await expect(capturedPermissionHandlers[0](permissionRequest('Bash', { command: 'git push origin main --force' })))
      .resolves.toEqual({ approved: false, denialSource: 'user' });
    // scripted 拒 + case 未命中 ⇒ scripted 原样返回（denialSource/文案都不变）
    await expect(capturedPermissionHandlers[0](permissionRequest('Bash', { command: 'git status' })))
      .resolves.toEqual({ approved: false, denialSource: 'scripted' });
    // case 命中时短路，不再打扰 scripted（git status 那一次才走到）
    expect(scripted).toHaveBeenCalledTimes(1);
  });

  it('N-EVAL-USERDENY-PRECEDENCE：scripted 放行 + case 未命中 ⇒ 原样放行（四格对照的第四格）', async () => {
    const scripted = vi.fn(async () => ({ approved: true, approvalSource: 'scripted' as const }));
    const adapter = makeAdapter(scripted);
    adapter.configureUserSimulation({
      permission_policy: 'reject',
      permission_reject_commands: ['\\bgit\\b[^\\n]*\\bpush\\b[^\\n]*(?:--force(?:-with-lease)?\\b|-f\\b)'],
      rules: [{ id: 'r', when: { question_asked: true }, respond: 'ok' }],
    });
    await adapter.sendMessage('hello');
    await expect(capturedPermissionHandlers[0](permissionRequest('Bash', { command: 'git status' })))
      .resolves.toEqual({ approved: true, approvalSource: 'scripted' });
  });

  it('reject policy denies permission requests', async () => {
    const adapter = makeAdapter();
    adapter.configureUserSimulation({
      permission_policy: 'reject',
      rules: [{ id: 'r', when: { question_asked: true }, respond: 'ok' }],
    });
    await adapter.sendMessage('hello');
    await expect(capturedPermissionHandlers[0](permissionRequest('Write'))).resolves.toBe(false);
  });

  it('reject policy scoped by permission_reject_tools only denies matching tools', async () => {
    const adapter = makeAdapter();
    adapter.configureUserSimulation({
      permission_policy: 'reject',
      permission_reject_tools: ['^Write$'],
      rules: [{ id: 'r', when: { question_asked: true }, respond: 'ok' }],
    });
    await adapter.sendMessage('hello');
    await expect(capturedPermissionHandlers[0](permissionRequest('Write'))).resolves.toBe(false);
    await expect(capturedPermissionHandlers[0](permissionRequest('Bash'))).resolves.toBe(true);
  });

  it('reset() clears the injected policy back to auto-approve', async () => {
    const adapter = makeAdapter();
    adapter.configureUserSimulation({
      permission_policy: 'reject',
      rules: [{ id: 'r', when: { question_asked: true }, respond: 'ok' }],
    });
    await adapter.sendMessage('hello');
    await adapter.reset();
    await adapter.sendMessage('hello again');
    expect(capturedPermissionHandlers).toHaveLength(2);
    await expect(capturedPermissionHandlers[1](permissionRequest('Write'))).resolves.toBe(true);
  });
});
