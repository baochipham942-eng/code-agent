import React from 'react';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { StructuredReplay } from '../../../src/shared/contract/evaluation';
import { ReplayAuditPanelView } from '../../../src/renderer/components/features/audit/ReplayAuditPanel';

function buildReplay(): StructuredReplay {
  return {
    sessionId: 'session-1',
    traceIdentity: {} as any,
    traceSource: {} as any,
    dataSource: 'telemetry',
    turns: [
      {
        turnNumber: 1,
        blocks: [
          {
            type: 'user',
            content: '专项研究 Alma memory quality',
            timestamp: 1,
          },
          {
            type: 'model_call',
            content: 'openai/gpt-5.4',
            timestamp: 2,
            modelDecision: {
              id: 'model-1',
              provider: 'openai',
              model: 'gpt-5.4',
              reason: 'strategy-deep',
              toolCallCount: 1,
              inputTokens: 1200,
              outputTokens: 500,
              latencyMs: 1200,
            },
          },
          {
            type: 'memory_audit',
            content: 'memory audit',
            timestamp: 3,
            memoryAudit: {
              mode: 'auto',
              blocks: [
                {
                  blockType: 'memory_index',
                  trigger: 'query',
                  source: 'memory',
                  injected: true,
                  chars: 320,
                  count: 1,
                  items: [
                    {
                      entryId: 'mem-1',
                      title: 'Alma memory benchmark',
                      kind: 'preference',
                      scope: 'global',
                      status: 'active',
                      preview: 'Memory indicators should explain retrieved evidence.',
                    } as any,
                  ],
                },
              ],
              suppressedEntryIds: ['mem-2'],
              score: {
                score: 86,
                max: 100,
                grade: 'good',
                breakdown: [
                  { dimension: 'strategy', score: 18, max: 20, status: 'good', reasons: ['deep route matched research'] },
                  { dimension: 'memory', score: 17, max: 20, status: 'good', reasons: ['memory evidence visible'] },
                ],
              },
              agentScorecard: {
                agentName: 'Coder',
                model: 'openai/gpt-5.4',
                strategyProfile: 'deep',
                memoryUsed: 1,
                toolsUsed: 1,
                warnings: 0,
                score: {
                  score: 86,
                  max: 100,
                  grade: 'good',
                  breakdown: [],
                },
              },
            },
          },
          {
            type: 'tool_call',
            content: 'rg',
            timestamp: 4,
            toolCall: {
              id: 'tool-1',
              name: 'rg',
              args: { q: 'memory' },
              success: true,
              duration: 10,
              category: 'Search',
            },
          },
        ],
        inputTokens: 1200,
        outputTokens: 500,
        durationMs: 2500,
        startTime: 1,
      },
    ],
    summary: {
      totalTurns: 1,
      toolDistribution: { Search: 1 },
      thinkingRatio: 0,
      selfRepairChains: 0,
      totalDurationMs: 2500,
      qualityScore: {
        score: 86,
        max: 100,
        grade: 'good',
        breakdown: [
          { dimension: 'strategy', score: 18, max: 20, status: 'good', reasons: ['deep route matched research'] },
          { dimension: 'memory', score: 17, max: 20, status: 'good', reasons: ['memory evidence visible'] },
        ],
      },
      agentScorecards: [
        {
          agentName: 'Coder',
          model: 'openai/gpt-5.4',
          strategyProfile: 'deep',
          memoryUsed: 1,
          toolsUsed: 1,
          warnings: 0,
          score: {
            score: 86,
            max: 100,
            grade: 'good',
            breakdown: [],
          },
        },
      ],
    },
  } as StructuredReplay;
}

describe('ReplayAuditPanelView', () => {
  it('renders session score, agent scorecard, memory audit, model route, and tools', () => {
    const html = renderToStaticMarkup(
      <ReplayAuditPanelView replay={buildReplay()} sessionTitle="Alma Audit" />,
    );

    expect(html).toContain('Replay/Audit');
    expect(html).toContain('Alma Audit');
    expect(html).toContain('86/100');
    expect(html).toContain('Agent Scorecards');
    expect(html).toContain('Alma memory benchmark');
    expect(html).toContain('openai/gpt-5.4');
    expect(html).toContain('工具调用 1');
  });
});
