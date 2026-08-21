import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeContext } from '../../../src/host/agent/runtime/runtimeContext';

const runtimeProbe = vi.hoisted(() => ({
  projectionDuringRun: undefined as RuntimeContext['turn']['modelFacingUserMessage'],
  inputDuringRun: undefined as string | undefined,
  assistantReply: undefined as string | undefined,
  error: undefined as Error | undefined,
  interrupted: false,
}));

const roleMocks = vi.hoisted(() => ({
  persistentRoleId: undefined as string | undefined,
  buildRoleContextBlock: vi.fn(async () => null as string | null),
  runRoleWriteBack: vi.fn(async () => ({ executed: true, written: 0, rejected: 0, historyAppended: true })),
  recordRoleParticipation: vi.fn(),
}));

vi.mock('../../../src/host/agent/runtime/conversationRuntime', () => ({
  ConversationRuntime: class {
    constructor(private readonly ctx: RuntimeContext) {}
    setModules(): void {}
    async run(userMessage: string): Promise<void> {
      runtimeProbe.projectionDuringRun = this.ctx.turn.modelFacingUserMessage;
      runtimeProbe.inputDuringRun = userMessage;
      if (runtimeProbe.error) throw runtimeProbe.error;
      if (runtimeProbe.assistantReply) {
        this.ctx.messages.push({
          id: 'assistant-current-turn',
          role: 'assistant',
          content: runtimeProbe.assistantReply,
          timestamp: 2,
          artifacts: [{ id: 'artifact-1', type: 'document', title: '交付文档', content: 'x', version: 1 }],
        });
      }
    }
    wasInterrupted(): boolean { return runtimeProbe.interrupted; }
  },
}));

vi.mock('../../../src/host/agent/runtime/toolExecutionEngine', () => ({
  ToolExecutionEngine: class { setModules(): void {} resetRepairGate(): void {} },
}));
vi.mock('../../../src/host/agent/runtime/contextAssembly', () => ({
  ContextAssembly: class { setModules(): void {} },
}));
vi.mock('../../../src/host/agent/runtime/runFinalizer', () => ({
  RunFinalizer: class { setModules(): void {} },
}));
vi.mock('../../../src/host/agent/runtime/learningPipeline', () => ({
  LearningPipeline: class {},
}));
vi.mock('../../../src/host/agent/runtime/runtimeStatePersistence', () => ({
  loadPersistedRuntimeState: vi.fn(() => null),
}));
vi.mock('../../../src/host/agent/runtime/scaffoldProfile', () => ({
  resolveScaffoldProfileForModel: vi.fn(() => ({ tier: 'standard', auditNudgeIntervalMultiplier: 1 })),
}));
vi.mock('../../../src/host/agent/runtime/turnCostPersistence', () => ({
  createTurnCostEventHandler: vi.fn(({ onEvent }: { onEvent: (event: unknown) => void }) => onEvent),
}));
vi.mock('../../../src/host/agent/persistentRoleResolution', () => ({
  resolvePersistentRoleId: vi.fn(async () => roleMocks.persistentRoleId),
}));
vi.mock('../../../src/host/services/roleAssets/roleAssetService', () => ({
  buildRoleContextBlock: roleMocks.buildRoleContextBlock,
}));
vi.mock('../../../src/host/services/roleAssets/roleWriteBack', () => ({
  runRoleWriteBack: roleMocks.runRoleWriteBack,
}));
vi.mock('../../../src/host/services/roleAssets/roleProactivity', () => ({
  recordRoleParticipation: roleMocks.recordRoleParticipation,
}));
vi.mock('../../../src/host/agent/capabilityGapTurnRecorder', () => ({
  recordCapabilityGapTurn: vi.fn(async () => undefined),
}));
vi.mock('../../../src/host/services/cloud/featureFlagService', () => ({
  getMaxIterations: vi.fn(() => 1),
}));
vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../../src/host/services/skills/comboRecorder', () => ({
  getComboRecorder: () => ({ startRecording: vi.fn(), markTurn: vi.fn() }),
}));
vi.mock('../../../src/host/context/autoCompressor', () => ({
  getAutoCompressor: vi.fn(() => ({})),
}));
vi.mock('../../../src/host/telemetry/telemetryAdapter', () => ({
  createTelemetryAdapter: vi.fn(() => ({})),
}));
vi.mock('../../../src/host/agent/metricsCollector', () => ({
  composeTelemetryAdapters: vi.fn((adapter: unknown) => adapter),
}));

import { AgentLoop } from '../../../src/host/agent/agentLoop';

beforeEach(() => {
  runtimeProbe.projectionDuringRun = undefined;
  runtimeProbe.inputDuringRun = undefined;
  runtimeProbe.assistantReply = undefined;
  runtimeProbe.error = undefined;
  runtimeProbe.interrupted = false;
  roleMocks.persistentRoleId = undefined;
  roleMocks.buildRoleContextBlock.mockReset().mockResolvedValue(null);
  roleMocks.runRoleWriteBack.mockReset().mockResolvedValue({
    executed: true,
    written: 0,
    rejected: 0,
    historyAppended: true,
  });
  roleMocks.recordRoleParticipation.mockReset();
});

function createLoop(messages: RuntimeContext['messages'], agentId = 'default'): AgentLoop {
  return new AgentLoop({
    modelConfig: { provider: 'mock', model: 'test-model', apiKey: 'test' },
    toolExecutor: {} as never,
    messages,
    onEvent: vi.fn(),
    workingDirectory: '/workspace',
    sessionId: 'session-role-turn',
    agentId,
    enableHooks: false,
  });
}

describe('AgentLoop turnSystemContext model-facing projection', () => {
  it('registers run(userMessage, displayPrompt) as a request-only projection and clears it after the run', async () => {
    const sourceMessageId = 'user-turn-system-context';
    const rawUserRequest = '执行验收';
    const executionContent = [
      '<workbench_preferences>优先使用已挂载 skill</workbench_preferences>',
      '<user_request>',
      rawUserRequest,
      '</user_request>',
    ].join('\n');
    const messages = [{
      id: sourceMessageId,
      role: 'user' as const,
      content: rawUserRequest,
      timestamp: 1,
    }];
    const loop = createLoop(messages);

    await loop.run(executionContent, rawUserRequest);

    expect(runtimeProbe.projectionDuringRun).toEqual({
      sourceMessageId,
      content: executionContent,
    });
    expect(messages[0].content).toBe(rawUserRequest);
    expect((loop as unknown as { ctx: RuntimeContext }).ctx.turn.modelFacingUserMessage).toBeUndefined();
  });

  it('injects role assets into the existing model-facing turn context only for a persistent role', async () => {
    roleMocks.persistentRoleId = '牧之';
    roleMocks.buildRoleContextBlock.mockResolvedValue('<role_assets role="牧之">长期资产</role_assets>');
    const messages = [{ id: 'user-1', role: 'user' as const, content: '帮我判断优先级', timestamp: 1 }];
    const loop = createLoop(messages, '牧之');

    await loop.run('已有工作台上下文\n\n<user_request>\n帮我判断优先级\n</user_request>', '帮我判断优先级');

    expect(roleMocks.buildRoleContextBlock).toHaveBeenCalledOnce();
    expect(roleMocks.buildRoleContextBlock).toHaveBeenCalledWith('牧之', '/workspace');
    expect(runtimeProbe.inputDuringRun).toContain('<role_assets role="牧之">长期资产</role_assets>');
    expect(runtimeProbe.inputDuringRun?.match(/<user_request>/g)).toHaveLength(1);
    expect(runtimeProbe.projectionDuringRun?.content).toBe(runtimeProbe.inputDuringRun);
    expect(messages[0].content).toBe('帮我判断优先级');
  });

  it('keeps a non-persistent explore turn byte-for-byte unchanged', async () => {
    const input = '探索当前目录';
    const loop = createLoop([{ id: 'user-1', role: 'user', content: input, timestamp: 1 }], 'explore');

    await loop.run(input);

    expect(roleMocks.buildRoleContextBlock).not.toHaveBeenCalled();
    expect(runtimeProbe.inputDuringRun).toBe(input);
  });

  it('projects injected role assets for a CLI turn without a separate displayPrompt', async () => {
    roleMocks.persistentRoleId = '牧之';
    roleMocks.buildRoleContextBlock.mockResolvedValue('<role_assets role="牧之">CLI 资产</role_assets>');
    const messages = [{ id: 'user-cli', role: 'user' as const, content: '继续', timestamp: 1 }];
    const loop = createLoop(messages, '牧之');

    await loop.run('继续');

    expect(runtimeProbe.projectionDuringRun).toEqual({
      sourceMessageId: 'user-cli',
      content: expect.stringContaining('<role_assets role="牧之">CLI 资产</role_assets>'),
    });
    expect(messages[0].content).toBe('继续');
  });

  it('does not duplicate the role block already carried by the voice execution payload', async () => {
    roleMocks.persistentRoleId = '牧之';
    const input = '<role_assets role="牧之">voice payload</role_assets>\n\n<user_request>\n执行派活\n</user_request>';
    const loop = createLoop([{ id: 'user-voice', role: 'user', content: '执行派活', timestamp: 1 }], '牧之');

    await loop.run(input, '执行派活');

    expect(roleMocks.buildRoleContextBlock).not.toHaveBeenCalled();
    expect(runtimeProbe.inputDuringRun).toBe(input);
  });

  it('writes back and records participation once after a successful turn with a final reply', async () => {
    roleMocks.persistentRoleId = '牧之';
    roleMocks.buildRoleContextBlock.mockResolvedValue('<role_assets role="牧之">资产</role_assets>');
    runtimeProbe.assistantReply = '最终助手回复';
    const loop = createLoop([{ id: 'user-1', role: 'user', content: '用户原话', timestamp: 1 }], '牧之');

    await loop.run('模型面请求', '用户原话');

    await vi.waitFor(() => expect(roleMocks.runRoleWriteBack).toHaveBeenCalledOnce());
    expect(roleMocks.runRoleWriteBack).toHaveBeenCalledWith({
      roleId: '牧之',
      workspacePath: '/workspace',
      taskPrompt: '用户原话',
      finalOutput: '最终助手回复',
      artifacts: [{ label: '交付文档', ref: 'artifact-1' }],
    });
    await vi.waitFor(() => expect(roleMocks.recordRoleParticipation).toHaveBeenCalledWith('session-role-turn', '牧之'));
    expect(roleMocks.recordRoleParticipation).toHaveBeenCalledOnce();
  });

  it('does not write back a failed or interrupted turn', async () => {
    roleMocks.persistentRoleId = '牧之';
    runtimeProbe.error = new Error('model failed');
    const failedLoop = createLoop([{ id: 'user-fail', role: 'user', content: '失败请求', timestamp: 1 }], '牧之');
    await expect(failedLoop.run('失败请求')).rejects.toThrow('model failed');

    runtimeProbe.error = undefined;
    runtimeProbe.interrupted = true;
    runtimeProbe.assistantReply = '中断前的片段';
    const interruptedLoop = createLoop([{ id: 'user-stop', role: 'user', content: '中断请求', timestamp: 1 }], '牧之');
    await interruptedLoop.run('中断请求');

    expect(roleMocks.runRoleWriteBack).not.toHaveBeenCalled();
    expect(roleMocks.recordRoleParticipation).not.toHaveBeenCalled();
  });

  it('does not fail the turn when role write-back rejects', async () => {
    roleMocks.persistentRoleId = '牧之';
    runtimeProbe.assistantReply = '正常返回';
    roleMocks.runRoleWriteBack.mockRejectedValue(new Error('write-back unavailable'));
    const loop = createLoop([{ id: 'user-1', role: 'user', content: '继续', timestamp: 1 }], '牧之');

    await expect(loop.run('继续')).resolves.toBeUndefined();
    await vi.waitFor(() => expect(roleMocks.runRoleWriteBack).toHaveBeenCalledOnce());
  });
});
