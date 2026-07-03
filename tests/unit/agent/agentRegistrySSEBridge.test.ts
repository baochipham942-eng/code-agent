// ============================================================================
// agentRegistrySSEBridge —— agents:changed 在 web 生产模式的 SSE 桥（S4）
// ----------------------------------------------------------------------------
// agentRegistry.ipc.ts 的广播走 BrowserWindow.getAllWindows()，web 模式
// （electronMock）返回 []，广播是 no-op —— renderer 的 agent registry 是启动
// 快照，agents/*.md 变更后 chip/面板显示名漂移。此桥在 webServer 侧订阅
// registry 变更并直接 broadcastSSE。
// ============================================================================
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { IPC_CHANNELS } from '../../../src/shared/ipc';

const mocks = vi.hoisted(() => ({
  onAgentRegistryChange: vi.fn<(handler: () => void) => () => void>(),
  listAllAgentsWithRoleFlag: vi.fn(async () => [{ id: 'coder', name: 'Coder' }]),
}));

vi.mock('../../../src/host/agent/agentRegistry', () => ({
  onAgentRegistryChange: mocks.onAgentRegistryChange,
  listAllAgentsWithRoleFlag: mocks.listAllAgentsWithRoleFlag,
}));

import { bridgeAgentRegistryChangesToSSE } from '../../../src/host/agent/agentRegistrySSEBridge';

describe('bridgeAgentRegistryChangesToSSE', () => {
  let changeHandler: (() => void) | null = null;
  const unsubscribe = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    changeHandler = null;
    mocks.onAgentRegistryChange.mockImplementation((handler) => {
      changeHandler = handler;
      return unsubscribe;
    });
  });

  it('registry 变更 → broadcastSSE(agents:changed, { agents })', async () => {
    const broadcast = vi.fn();
    bridgeAgentRegistryChangesToSSE(broadcast);

    expect(changeHandler).toBeTruthy();
    changeHandler!();
    await vi.waitFor(() => {
      expect(broadcast).toHaveBeenCalledWith(IPC_CHANNELS.AGENTS_CHANGED, {
        agents: [{ id: 'coder', name: 'Coder' }],
      });
    });
  });

  it('列表读取失败不抛错（非致命）', async () => {
    mocks.listAllAgentsWithRoleFlag.mockRejectedValueOnce(new Error('boom'));
    const broadcast = vi.fn();
    bridgeAgentRegistryChangesToSSE(broadcast);

    expect(() => changeHandler!()).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('返回 unsubscribe 透传', () => {
    const dispose = bridgeAgentRegistryChangesToSSE(vi.fn());
    dispose();
    expect(unsubscribe).toHaveBeenCalled();
  });
});
