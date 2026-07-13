import { describe, expect, it } from 'vitest';
import type { RuntimeContext } from '../../../src/host/agent/runtime/runtimeContext';
import { TurnState } from '../../../src/host/agent/runtime/turnState';
import { ContextHealthState } from '../../../src/host/agent/runtime/contextHealthState';
import {
  buildTurnQualitySummary,
  recordTurnMemoryBlock,
  recordTurnMemoryDisabled,
} from '../../../src/host/agent/runtime/turnQuality';

function runtime(overrides: Partial<RuntimeContext> = {}): RuntimeContext {
  return {
    memoryMode: 'auto',
    suppressedMemoryEntryIds: [],
    modelConfig: {
      provider: 'openai',
      model: 'gpt-4.1',
    },
    turn: TurnState.forTest({ effortLevel: 'high' }),
    contextHealth: ContextHealthState.forTest({ droppedPromptBlocks: [] } as never),
    pendingRuntimeDiagnostics: [],
    turnQualityState: {},
    ...overrides,
  } as unknown as RuntimeContext;
}

describe('turnQuality', () => {
  it('records memory-off turns and strategy metadata', () => {
    const ctx = runtime({ memoryMode: 'off' });

    recordTurnMemoryDisabled(ctx, 'session_memory_off');
    const summary = buildTurnQualitySummary(ctx);

    expect(summary.memory.mode).toBe('off');
    expect(summary.memory.offReason).toBe('session_memory_off');
    expect(summary.strategy).toMatchObject({
      provider: 'openai',
      model: 'gpt-4.1',
      requestedProvider: 'openai',
      requestedModel: 'gpt-4.1',
      effortLevel: 'high',
    });
    expect(summary.score.score).toBeGreaterThan(0);
    expect(summary.agentScorecard?.score.grade).toBeDefined();
  });

  it('keeps visible memory block evidence lightweight', () => {
    const ctx = runtime({ suppressedMemoryEntryIds: ['mem-hidden'] });

    recordTurnMemoryBlock(ctx, {
      blockType: 'memory_hint',
      trigger: 'default_memory_hint',
      source: 'light-memory-tool-hint',
      injected: true,
      chars: 88,
      count: 1,
    });
    const summary = buildTurnQualitySummary(ctx, {
      type: 'text',
      content: 'done',
      actualProvider: 'openai',
      actualModel: 'gpt-4.1-mini',
    });

    expect(summary.memory.mode).toBe('auto');
    expect(summary.memory.suppressedEntryIds).toEqual(['mem-hidden']);
    expect(summary.memory.blocks[0]).toMatchObject({
      blockType: 'memory_hint',
      injected: true,
      count: 1,
    });
    expect(summary.strategy.model).toBe('gpt-4.1-mini');
  });

  it('surfaces task strategy decision in scorecard metadata', () => {
    const ctx = runtime({
      turnModelDecision: {
        requestedProvider: 'openai',
        requestedModel: 'gpt-4.1',
        resolvedProvider: 'deepseek',
        resolvedModel: 'deepseek-v4-pro',
        role: null,
        reason: 'strategy-deep',
        billingMode: 'payg',
        fallbackFrom: null,
        strategyProfile: 'deep',
        strategyRuleId: 'research-deep',
        strategyReason: '复杂研究使用深度任务模型',
        taskComplexity: {
          level: 'complex',
          score: 85,
          signals: ['complex_keyword'],
        },
      },
      agentId: 'coder',
      agentName: 'Coder',
      turn: TurnState.forTest({ effortLevel: 'high', toolsUsedInTurn: ['Read', 'Edit'] }),
    });

    const summary = buildTurnQualitySummary(ctx, {
      type: 'text',
      content: 'done',
      actualProvider: 'deepseek',
      actualModel: 'deepseek-v4-pro',
    });

    expect(summary.strategy).toMatchObject({
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
      profile: 'deep',
      ruleId: 'research-deep',
      reason: '复杂研究使用深度任务模型',
    });
    expect(summary.score.breakdown.some((item) => item.dimension === 'strategy')).toBe(true);
    expect(summary.agentScorecard).toMatchObject({
      agentId: 'coder',
      agentName: 'Coder',
      toolsUsed: 2,
      strategyProfile: 'deep',
    });
  });

  it('capabilities 透出 requestedAgentId（显式选择降级时 ≠ agentId，供徽标判定）', () => {
    const ctx = runtime({
      agentId: 'default',
      agentName: 'default',
      requestedAgentId: '__ghost__',
    });

    const summary = buildTurnQualitySummary(ctx);

    expect(summary.capabilities?.agentId).toBe('default');
    expect(summary.capabilities?.requestedAgentId).toBe('__ghost__');
  });

  it('无显式请求时 capabilities.requestedAgentId 不出现', () => {
    const ctx = runtime({ agentId: 'coder', agentName: 'Coder' });

    const summary = buildTurnQualitySummary(ctx);

    expect(summary.capabilities?.requestedAgentId).toBeUndefined();
  });
});
