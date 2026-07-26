import { describe, expect, it } from 'vitest';
import { CONTEXT_LEDGER, PROMPT_VERSION } from '../../../../src/shared/constants/agent';
import type { ContextEventRecord } from '../../../../src/host/context/contextEventLedger';
import { summarizePromptStack } from '../../../../src/host/services/promptStack/promptStackSummary';

describe('summarizePromptStack', () => {
  it('summarizes the selected invocation from ledger records', () => {
    const events: ContextEventRecord[] = [
      {
        id: 'checkpoint',
        sessionId: 'session-1',
        agentId: 'agent-1',
        messageId: 'compaction-message-1',
        sourceKind: 'compression_survivor',
        sourceDetail: 'autocompact:collapse',
        layer: 'autocompact',
        timestamp: 100,
      },
      {
        id: 'base',
        sessionId: 'session-1',
        agentId: 'agent-1',
        invocationId: 'turn-1',
        sourceKind: CONTEXT_LEDGER.SOURCE_KIND.PROMPT_LAYER,
        sourceDetail: CONTEXT_LEDGER.BASE_SOURCE.TASK,
        layer: CONTEXT_LEDGER.BASE_SOURCE.TASK,
        sequence: 0,
        chars: 120,
        tokens: 30,
        promptLayerOutcome: CONTEXT_LEDGER.PROMPT_LAYER_OUTCOME.INCLUDED,
        timestamp: 200,
      },
      {
        id: 'skills',
        sessionId: 'session-1',
        agentId: 'agent-1',
        invocationId: 'turn-1',
        sourceKind: CONTEXT_LEDGER.SOURCE_KIND.PROMPT_LAYER,
        sourceDetail: 'skills',
        layer: 'skills',
        sequence: 1,
        chars: 80,
        tokens: 20,
        promptLayerOutcome: CONTEXT_LEDGER.PROMPT_LAYER_OUTCOME.TRIMMED,
        timestamp: 200,
      },
      {
        id: 'tools',
        sessionId: 'session-1',
        agentId: 'agent-1',
        invocationId: 'turn-1',
        sourceKind: CONTEXT_LEDGER.SOURCE_KIND.TOOL_SCHEMA_SNAPSHOT,
        toolNames: ['Read', 'Write'],
        schemaHash: 'hash-1',
        timestamp: 201,
      },
      {
        id: 'model',
        sessionId: 'session-1',
        agentId: 'agent-1',
        invocationId: 'turn-1',
        sourceKind: CONTEXT_LEDGER.SOURCE_KIND.MODEL_BINDING,
        model: 'test-model',
        provider: 'test-provider',
        timestamp: 201,
      },
      {
        id: 'other-agent',
        sessionId: 'session-1',
        agentId: 'agent-2',
        invocationId: 'turn-2',
        sourceKind: CONTEXT_LEDGER.SOURCE_KIND.PROMPT_LAYER,
        sourceDetail: 'wrong-agent-layer',
        layer: 'wrong-agent-layer',
        chars: 999,
        tokens: 999,
        promptLayerOutcome: CONTEXT_LEDGER.PROMPT_LAYER_OUTCOME.INCLUDED,
        timestamp: 300,
      },
    ];

    const summary = summarizePromptStack(events, {
      sessionId: 'session-1',
      agentId: 'agent-1',
    });

    expect(summary.promptVersion).toBe(PROMPT_VERSION);
    expect(summary.invocationId).toBe('turn-1');
    expect(summary.totalChars).toBe(120);
    expect(summary.totalTokens).toBe(30);
    expect(summary.layers).toEqual([
      expect.objectContaining({
        id: CONTEXT_LEDGER.BASE_SOURCE.TASK,
        present: true,
        outcome: CONTEXT_LEDGER.PROMPT_LAYER_OUTCOME.INCLUDED,
      }),
      expect.objectContaining({
        id: 'skills',
        present: false,
        outcome: CONTEXT_LEDGER.PROMPT_LAYER_OUTCOME.TRIMMED,
      }),
    ]);
    expect(summary.activeTools).toEqual({
      names: ['Read', 'Write'],
      count: 2,
      schemaHash: 'hash-1',
    });
    expect(summary.modelBinding).toEqual({
      model: 'test-model',
      provider: 'test-provider',
    });
    expect(summary.compactionCheckpoint).toEqual({
      messageId: 'compaction-message-1',
      timestamp: 100,
      layer: 'autocompact',
      operation: 'collapse',
    });
    expect(JSON.stringify(summary)).not.toContain('wrong-agent-layer');
  });

  it('reports no call record instead of synthesizing a static prompt summary', () => {
    const summary = summarizePromptStack([], { sessionId: 'session-empty' });

    expect(summary.invocationId).toBeUndefined();
    expect(summary.layers).toEqual([]);
    expect(summary.totalChars).toBe(0);
    expect(summary.totalTokens).toBe(0);
    expect(summary.warnings).toContain('No model invocation record found for this session.');
  });
});
