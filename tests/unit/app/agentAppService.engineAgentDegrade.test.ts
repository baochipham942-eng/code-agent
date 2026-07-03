// ============================================================================
// Electron IPC 路径：外部引擎会话 + 显式 agent 选择 → 降级 routing_resolved
// ----------------------------------------------------------------------------
// codex-audit round 2 MEDIUM：agentAppService.sendMessage 的外部引擎分支在
// preferredAgentId 消费点（withWorkbenchTurnSystemContext → agentOverrideId）
// 之前 return，显式选择被静默忽略——与 web /api/run 同款旁路（已修）。
// 对称修法：引擎分支前发降级事件（经 TaskManager.emitAgentEventForSession）。
// ============================================================================

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentAppServiceImpl } from '../../../src/host/app/agentAppService';
import { getSessionManager } from '../../../src/host/services';

vi.mock('../../../src/host/services', () => ({
  getSessionManager: vi.fn(),
}));
vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: vi.fn(() => ({ getMessageById: vi.fn() })),
}));
vi.mock('../../../src/host/session/streamSnapshot', () => ({
  loadStreamSnapshot: vi.fn(),
}));
vi.mock('../../../src/host/services/checkpoint', () => ({
  getFileCheckpointService: vi.fn(),
}));
vi.mock('../../../src/host/services/commands/promptCommandService', () => ({
  applyPromptCommandExpansion: vi.fn(async (envelope: unknown) => envelope),
}));

const engineMocks = vi.hoisted(() => ({
  codexRun: vi.fn(async () => ({ status: 'completed' })),
}));

vi.mock('../../../src/host/services/agentEngine', () => ({
  CodexCliAdapter: vi.fn(function CodexCliAdapterMock() {
    return { run: engineMocks.codexRun };
  }),
  ClaudeCodeAdapter: vi.fn(),
  MimoCliAdapter: vi.fn(),
  KimiCliAdapter: vi.fn(),
  isExternalAgentEngine: (kind: unknown) =>
    kind === 'codex_cli' || kind === 'claude_code' || kind === 'mimo_code' || kind === 'kimi_code',
  resolveExternalEngineLaunch: vi.fn(() => ({
    cwd: '/tmp/engine-ws',
    workspaceRoot: '/tmp/engine-ws',
    permissionProfile: 'read_only',
    model: undefined,
  })),
  getRemoteAgentEngineModelCatalogService: () => ({
    resolveModelId: async () => undefined,
  }),
}));

describe('AgentAppService 外部引擎会话的显式 agent 选择降级', () => {
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
    taskManager = {
      getOrCreateCurrentOrchestrator: vi.fn(() => ({
        setWorkingDirectory: vi.fn(),
        getWorkingDirectory: vi.fn(() => '/tmp/engine-ws'),
      })),
      emitAgentEventForSession: vi.fn(),
      startTask: vi.fn(),
      cleanup: vi.fn(),
      setCurrentSessionId: vi.fn(),
      setSessionContext: vi.fn(),
    };
    vi.mocked(getSessionManager).mockReturnValue({
      getSession: vi.fn(async () => ({
        id: 'session-engine',
        workingDirectory: '/tmp/engine-ws',
        engine: { kind: 'codex_cli', cwd: '/tmp/engine-ws', permissionProfile: 'read_only', origin: 'manual' },
      })),
      updateSession: vi.fn(),
    } as never);
  });

  function createService(): AgentAppServiceImpl {
    return new AgentAppServiceImpl(
      () => taskManager as never,
      () => null,
      () => 'session-engine',
      vi.fn(),
    );
  }

  it('引擎会话 + preferredAgentId → 发降级 routing_resolved（fallbackAgentName=引擎 kind）', async () => {
    const service = createService();
    await service.sendMessage({
      sessionId: 'session-engine',
      content: 'hi',
      context: { preferredAgentId: 'explore' },
    });

    expect(engineMocks.codexRun).toHaveBeenCalled();
    expect(taskManager.emitAgentEventForSession).toHaveBeenCalledWith(
      'session-engine',
      expect.objectContaining({
        type: 'routing_resolved',
        data: expect.objectContaining({
          mode: 'explicit',
          agentId: 'default',
          agentName: 'Codex CLI',
          requestedAgentId: 'explore',
          fallbackToDefault: true,
        }),
      }),
    );
  });

  it('引擎会话无显式选择 → 不发降级事件', async () => {
    const service = createService();
    await service.sendMessage({
      sessionId: 'session-engine',
      content: 'hi',
      context: {},
    });

    expect(engineMocks.codexRun).toHaveBeenCalled();
    expect(taskManager.emitAgentEventForSession).not.toHaveBeenCalled();
  });
});
