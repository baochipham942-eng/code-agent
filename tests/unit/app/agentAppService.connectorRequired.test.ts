// ============================================================================
// N-CONNECTOR-POLISH-AUDIT-FU1：选中 / 专家声明的连接器没就绪 → 每轮首个模型输出前
// 发且只发一次 connector_required；就绪或没选 → 不发。
// ============================================================================

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentAppServiceImpl } from '../../../src/host/app/agentAppService';
import { getSessionManager } from '../../../src/host/services';

const resolveAgentMock = vi.hoisted(() => vi.fn());
vi.mock('../../../src/host/agent/agentRegistry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/host/agent/agentRegistry')>();
  return { ...actual, resolveAgent: resolveAgentMock };
});
vi.mock('../../../src/host/observability/posthogNode', () => ({ trackNode: vi.fn() }));
const cliConnectorStatus = vi.hoisted(() => ({} as Record<string, { connected: boolean } | undefined>));
vi.mock('../../../src/host/connectors/cli/cliConnectorStatusCache', () => ({
  isCliConnectorId: (id: string) => id === 'feishu' || id === 'tmeet',
  getCachedCliConnectorConnectionStatus: (id: string) => cliConnectorStatus[id],
}));
vi.mock('../../../src/host/services', () => ({ getSessionManager: vi.fn() }));
vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: vi.fn(() => ({
    getMessageById: vi.fn(),
    getSessionForkLineage: vi.fn(() => null),
    getSessionForkContextSource: vi.fn(() => null),
  })),
}));
vi.mock('../../../src/host/session/streamSnapshot', () => ({ loadStreamSnapshot: vi.fn() }));
vi.mock('../../../src/host/services/checkpoint', () => ({ getFileCheckpointService: vi.fn() }));
vi.mock('../../../src/host/services/commands/promptCommandService', () => ({
  applyPromptCommandExpansion: vi.fn(async (envelope: unknown) => envelope),
}));

describe('agentAppService.sendMessage → connector_required', () => {
  const order: string[] = [];
  let taskManager: {
    getOrCreateCurrentOrchestrator: ReturnType<typeof vi.fn>;
    emitAgentEventForSession: ReturnType<typeof vi.fn>;
    startTask: ReturnType<typeof vi.fn>;
    cleanup: ReturnType<typeof vi.fn>;
    setCurrentSessionId: ReturnType<typeof vi.fn>;
    setSessionContext: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    order.length = 0;
    for (const key of Object.keys(cliConnectorStatus)) delete cliConnectorStatus[key];
    resolveAgentMock.mockReset();
    taskManager = {
      getOrCreateCurrentOrchestrator: vi.fn(() => ({
        setWorkingDirectory: vi.fn(),
        getWorkingDirectory: vi.fn(() => '/tmp/ws'),
      })),
      emitAgentEventForSession: vi.fn(() => { order.push('emit'); }),
      startTask: vi.fn(async () => { order.push('startTask'); }),
      cleanup: vi.fn(),
      setCurrentSessionId: vi.fn(),
      setSessionContext: vi.fn(),
    };
    vi.mocked(getSessionManager).mockReturnValue({
      getSession: vi.fn(async () => ({ id: 'session-1', workingDirectory: '/tmp/ws' })),
      getSessionMetadata: vi.fn(() => undefined),
      updateSession: vi.fn(),
    } as never);
  });

  function createService(): AgentAppServiceImpl {
    return new AgentAppServiceImpl(() => taskManager as never, () => null, () => 'session-1', vi.fn());
  }

  function connectorRequiredCalls() {
    return taskManager.emitAgentEventForSession.mock.calls.filter(([, event]) => event.type === 'connector_required');
  }

  it('选中的 CLI 连接器没连上 → 恰好一次 connector_required，且早于 startTask（首个模型输出前）', async () => {
    cliConnectorStatus.feishu = { connected: false };
    await createService().sendMessage({
      sessionId: 'session-1',
      content: 'hi',
      context: { selectedConnectorIds: ['feishu'] },
    });

    const calls = connectorRequiredCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe('session-1');
    expect(calls[0][1]).toEqual({
      type: 'connector_required',
      data: { connectors: [{ id: 'feishu', source: 'selected', reason: 'not_connected' }] },
    });
    expect(order).toEqual(['emit', 'startTask']);
    // 模型可见：turnSystemContext 里有「尚未连接」提示行
    const runOptions = taskManager.startTask.mock.calls[0][3];
    expect(JSON.stringify(runOptions.turnSystemContext)).toContain('尚未连接');
  });

  it('选中的连接器已连上 → 不发', async () => {
    cliConnectorStatus.feishu = { connected: true };
    await createService().sendMessage({
      sessionId: 'session-1',
      content: 'hi',
      context: { selectedConnectorIds: ['feishu'] },
    });
    expect(connectorRequiredCalls()).toHaveLength(0);
    expect(taskManager.startTask).toHaveBeenCalled();
  });

  it('没选连接器 → 不发', async () => {
    await createService().sendMessage({ sessionId: 'session-1', content: 'hi', context: {} });
    expect(connectorRequiredCalls()).toHaveLength(0);
  });

  it('专家声明的 core 连接器没连上 → source=expert', async () => {
    cliConnectorStatus.tmeet = { connected: false };
    resolveAgentMock.mockReturnValue({ id: 'writer', name: 'writer', connectors: [{ id: 'tmeet', level: 'core' }] });
    await createService().sendMessage({
      sessionId: 'session-1',
      content: 'hi',
      context: { preferredAgentId: 'writer' },
    });
    const calls = connectorRequiredCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0][1].data.connectors).toEqual([{ id: 'tmeet', source: 'expert', reason: 'not_connected' }]);
  });

  it('会话手选覆盖专家：手选已连上时专家未连上的声明不发', async () => {
    cliConnectorStatus.feishu = { connected: true };
    cliConnectorStatus.tmeet = { connected: false };
    resolveAgentMock.mockReturnValue({ id: 'writer', name: 'writer', connectors: [{ id: 'tmeet', level: 'core' }] });
    await createService().sendMessage({
      sessionId: 'session-1',
      content: 'hi',
      context: { preferredAgentId: 'writer', selectedConnectorIds: ['feishu'] },
    });
    expect(connectorRequiredCalls()).toHaveLength(0);
  });
});
