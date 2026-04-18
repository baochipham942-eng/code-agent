import { describe, expect, it } from 'vitest';
import type { TraceProjection } from '../../../src/shared/contract/trace';
import { extractCurrentTurnRoutingEvidence } from '../../../src/renderer/hooks/useCurrentTurnRoutingEvidence';

describe('extractCurrentTurnRoutingEvidence', () => {
  it('uses the latest turn instead of activeTurnIndex', () => {
    const projection: TraceProjection = {
      sessionId: 'session-1',
      activeTurnIndex: 0,
      turns: [
        {
          turnId: 'turn-1',
          turnNumber: 1,
          status: 'completed',
          startTime: 100,
          endTime: 140,
          nodes: [
            {
              id: 'routing-turn-1',
              type: 'turn_timeline',
              content: '',
              timestamp: 120,
              turnTimeline: {
                id: 'routing-turn-1',
                kind: 'routing_evidence',
                timestamp: 120,
                tone: 'info',
                routingEvidence: {
                  mode: 'direct',
                  summary: 'Direct 已发送给 builder',
                  steps: [
                    {
                      status: 'delivered',
                      label: '已发送给 builder',
                      tone: 'success',
                    },
                  ],
                },
              },
            },
          ],
        },
        {
          turnId: 'turn-2',
          turnNumber: 2,
          status: 'completed',
          startTime: 200,
          endTime: 260,
          nodes: [
            {
              id: 'routing-turn-2',
              type: 'turn_timeline',
              content: '',
              timestamp: 240,
              turnTimeline: {
                id: 'routing-turn-2',
                kind: 'routing_evidence',
                timestamp: 240,
                tone: 'warning',
                routingEvidence: {
                  mode: 'parallel',
                  summary: '并行编排已启动',
                  steps: [
                    {
                      status: 'requested',
                      label: '准备启动 3 个 agent',
                      tone: 'warning',
                    },
                    {
                      status: 'started',
                      label: '启动 3 个并行 agent',
                      tone: 'success',
                    },
                  ],
                },
              },
            },
          ],
        },
      ],
    };

    expect(extractCurrentTurnRoutingEvidence(projection)).toMatchObject({
      turnId: 'turn-2',
      turnNumber: 2,
      tone: 'warning',
      routingEvidence: {
        mode: 'parallel',
        summary: '并行编排已启动',
      },
    });
  });

  it('returns null when the latest turn has no routing evidence', () => {
    const projection: TraceProjection = {
      sessionId: 'session-1',
      activeTurnIndex: 1,
      turns: [
        {
          turnId: 'turn-1',
          turnNumber: 1,
          status: 'completed',
          startTime: 100,
          endTime: 140,
          nodes: [
            {
              id: 'routing-turn-1',
              type: 'turn_timeline',
              content: '',
              timestamp: 120,
              turnTimeline: {
                id: 'routing-turn-1',
                kind: 'routing_evidence',
                timestamp: 120,
                tone: 'info',
                routingEvidence: {
                  mode: 'direct',
                  summary: 'Direct 已发送给 builder',
                  steps: [],
                },
              },
            },
          ],
        },
        {
          turnId: 'turn-2',
          turnNumber: 2,
          status: 'completed',
          startTime: 200,
          endTime: 240,
          nodes: [
            {
              id: 'assistant-2',
              type: 'assistant_text',
              content: 'done',
              timestamp: 220,
            },
          ],
        },
      ],
    };

    expect(extractCurrentTurnRoutingEvidence(projection)).toBeNull();
  });
});
