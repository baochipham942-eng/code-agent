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

const capturedPermissionHandlers: Array<(req: PermissionRequestData) => Promise<boolean>> = [];

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
    constructor(config: { requestPermission: (req: PermissionRequestData) => Promise<boolean> }) {
      capturedPermissionHandlers.push(config.requestPermission);
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

function permissionRequest(tool: string): PermissionRequestData {
  return { type: 'file_write', tool, details: {} };
}

function makeAdapter(): StandaloneAgentAdapter {
  return new StandaloneAgentAdapter({
    workingDirectory: '/tmp',
    modelConfig: { provider: 'mock', model: 'mock-model' },
  });
}

beforeEach(() => {
  capturedPermissionHandlers.length = 0;
});

describe('StandaloneAgentAdapter permission policy injection', () => {
  it('defaults to auto-approve when no user_simulation configured (legacy eval behavior)', async () => {
    const adapter = makeAdapter();
    await adapter.sendMessage('hello');
    expect(capturedPermissionHandlers).toHaveLength(1);
    await expect(capturedPermissionHandlers[0](permissionRequest('Write'))).resolves.toBe(true);
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
