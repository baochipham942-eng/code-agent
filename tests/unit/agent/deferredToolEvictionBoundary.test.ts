import { beforeEach, describe, expect, it } from 'vitest';
import { checkAndAutoCompress } from '../../../src/host/agent/runtime/contextAssembly/compression';
import type { ContextAssemblyCtx } from '../../../src/host/agent/runtime/contextAssembly/shared';
import { getProtocolRegistry, resetProtocolRegistry } from '../../../src/host/tools/protocolRegistry';
import { getToolSearchService, resetToolSearchService } from '../../../src/host/services/toolSearch';
import type { ToolModule, ToolSchema } from '../../../src/host/protocol/tools';

function registerTask(): void {
  const schema: ToolSchema = {
    name: 'Task',
    description: 'Task test schema',
    outputSchema: { type: 'string' },
    inputSchema: { type: 'object', properties: {} },
    category: 'planning',
    permissionLevel: 'execute',
    readOnly: false,
  };
  const module: ToolModule = {
    schema,
    createHandler: () => ({
      schema,
      async execute() {
        return { ok: true, output: null };
      },
    }),
  };
  getProtocolRegistry().register(schema, async () => module);
}

describe('deferred tool eviction stays off skipped compaction', () => {
  beforeEach(() => {
    resetProtocolRegistry();
    registerTask();
    resetToolSearchService();
  });

  it('leaves the loaded set unchanged when summary compaction is in cooldown', async () => {
    const service = getToolSearchService();
    expect(service.selectTool('Task', 'session-a').loadedTools).toEqual(['Task']);
    service.beginRound('session-a');
    service.markToolCalled('Task', 'session-a');
    service.beginRound('session-a');
    service.beginRound('session-a');
    service.beginRound('session-a');

    const ctx = {
      generateId: () => 'signal-1',
      injectSystemMessage: () => undefined,
      compressionRecovery: {
        _consecutiveCompacts: 0,
        _autoCompactPaused: false,
        _summaryFailureStreak: 3,
        _summaryCooldownUntil: Date.now() + 60_000,
      },
      runtime: {
        sessionId: 'session-a',
        agentId: 'subagent-a',
        workingDirectory: '/tmp',
        messages: [{ id: 'm1', role: 'user', content: 'hello' }],
        modelConfig: { provider: 'openai', model: 'gpt-4o' },
        onEvent: () => undefined,
        contextHealth: {
          pipelineAutocompactNeeded: false,
          checkpointRebuildLastWatermarkId: undefined,
          setPipelineAutocompactNeeded: () => undefined,
        },
        autoCompressor: {
          getConfig: () => ({ warningThreshold: 0.8, enabled: true, preserveRecentCount: 8 }),
          shouldTriggerByTokens: () => true,
        },
      },
    } as unknown as ContextAssemblyCtx;

    await checkAndAutoCompress(ctx);

    expect(service.getLoadedDeferredTools()).toEqual(['Task']);
    expect(service.evictIdleDeferredToolsAtCompactionBoundary(3, 'session-a')).toEqual(['Task']);
  });

  it('leaves the loaded set unchanged when lossless budgeting skips compaction', async () => {
    const service = getToolSearchService();
    expect(service.selectTool('Task', 'session-a').loadedTools).toEqual(['Task']);
    service.beginRound('session-a');
    service.beginRound('session-a');
    service.beginRound('session-a');
    service.beginRound('session-a');

    let thresholdChecks = 0;
    const ctx = {
      generateId: () => 'signal-2',
      injectSystemMessage: () => undefined,
      compressionRecovery: {
        _consecutiveCompacts: 0,
        _autoCompactPaused: false,
        _summaryFailureStreak: 0,
        _summaryCooldownUntil: 0,
      },
      runtime: {
        sessionId: 'session-a',
        agentId: 'subagent-a',
        workingDirectory: '/tmp',
        messages: [{ id: 'm1', role: 'user', content: 'hello' }],
        modelConfig: { provider: 'openai', model: 'gpt-4o' },
        onEvent: () => undefined,
        contextHealth: {
          pipelineAutocompactNeeded: false,
          checkpointRebuildLastWatermarkId: undefined,
          setPipelineAutocompactNeeded: () => undefined,
        },
        autoCompressor: {
          getConfig: () => ({ warningThreshold: 0.8, enabled: true, preserveRecentCount: 8 }),
          shouldTriggerByTokens: () => {
            thresholdChecks += 1;
            return thresholdChecks === 1;
          },
        },
      },
    } as unknown as ContextAssemblyCtx;

    await checkAndAutoCompress(ctx);

    expect(thresholdChecks).toBeGreaterThanOrEqual(2);
    expect(service.getLoadedDeferredTools()).toEqual(['Task']);
  });
});
