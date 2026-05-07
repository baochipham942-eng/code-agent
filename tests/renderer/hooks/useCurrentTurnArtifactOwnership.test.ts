import { describe, expect, it } from 'vitest';
import type { TraceProjection } from '../../../src/shared/contract/trace';
import { extractCurrentTurnArtifactOwnership } from '../../../src/renderer/hooks/useCurrentTurnArtifactOwnership';

describe('extractCurrentTurnArtifactOwnership', () => {
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
              id: 'artifact-turn-1',
              type: 'turn_timeline',
              content: '',
              timestamp: 120,
              turnTimeline: {
                id: 'artifact-turn-1',
                kind: 'artifact_ownership',
                timestamp: 120,
                tone: 'success',
                artifactOwnership: [
                  {
                    kind: 'file',
                    label: 'old-report.md',
                    ownerKind: 'tool',
                    ownerLabel: 'Write',
                  },
                ],
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
              id: 'artifact-turn-2',
              type: 'turn_timeline',
              content: '',
              timestamp: 240,
              turnTimeline: {
                id: 'artifact-turn-2',
                kind: 'artifact_ownership',
                timestamp: 240,
                tone: 'success',
                artifactOwnership: [
                  {
                    kind: 'artifact',
                    label: 'Execution Chart',
                    ownerKind: 'assistant',
                    ownerLabel: 'reviewer',
                  },
                  {
                    kind: 'file',
                    label: 'report.md',
                    ownerKind: 'tool',
                    ownerLabel: 'reviewer · Write',
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    expect(extractCurrentTurnArtifactOwnership(projection)).toMatchObject({
      turnId: 'turn-2',
      turnNumber: 2,
      artifactOwnership: [
        {
          kind: 'artifact',
          label: 'Execution Chart',
        },
        {
          kind: 'file',
          label: 'report.md',
        },
      ],
    });
  });

  it('returns null when the latest turn has no artifact ownership', () => {
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
              id: 'artifact-turn-1',
              type: 'turn_timeline',
              content: '',
              timestamp: 120,
              turnTimeline: {
                id: 'artifact-turn-1',
                kind: 'artifact_ownership',
                timestamp: 120,
                tone: 'success',
                artifactOwnership: [
                  {
                    kind: 'file',
                    label: 'old-report.md',
                    ownerKind: 'tool',
                    ownerLabel: 'Write',
                  },
                ],
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

    expect(extractCurrentTurnArtifactOwnership(projection)).toBeNull();
  });

  it('uses structured tool artifact metadata when no ownership timeline exists yet', () => {
    const projection: TraceProjection = {
      sessionId: 'session-1',
      activeTurnIndex: 0,
      turns: [
        {
          turnId: 'turn-1',
          turnNumber: 1,
          status: 'completed',
          startTime: 100,
          endTime: 160,
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
                tone: 'success',
                routingEvidence: {
                  mode: 'direct',
                  summary: 'Direct 已发送给 analyst',
                  agentNames: ['analyst'],
                  steps: [],
                },
              },
            },
            {
              id: 'tool-fetch',
              type: 'tool_call',
              content: '',
              timestamp: 140,
              toolCall: {
                id: 'tool-fetch',
                name: 'web_fetch',
                args: {},
                result: 'saved',
                success: true,
                metadata: {
                  artifact: {
                    artifactId: 'artifact-fetch',
                    kind: 'web',
                    sourceTool: 'web_fetch',
                    createdAt: '2026-05-07T00:00:00.000Z',
                    name: 'research.md',
                    path: 'exports/research.md',
                  },
                },
              },
            },
          ],
        },
      ],
    };

    expect(extractCurrentTurnArtifactOwnership(projection)).toMatchObject({
      turnId: 'turn-1',
      turnNumber: 1,
      tone: 'success',
      artifactOwnership: [
        {
          kind: 'file',
          label: 'research.md',
          ownerKind: 'tool',
          ownerLabel: 'analyst · web_fetch',
          path: 'exports/research.md',
          sourceNodeId: 'tool-fetch',
        },
      ],
    });
  });

  it('merges structured tool artifact metadata with timeline ownership without duplicating paths', () => {
    const projection: TraceProjection = {
      sessionId: 'session-1',
      activeTurnIndex: 0,
      turns: [
        {
          turnId: 'turn-1',
          turnNumber: 1,
          status: 'completed',
          startTime: 100,
          endTime: 180,
          nodes: [
            {
              id: 'artifact-turn-1',
              type: 'turn_timeline',
              content: '',
              timestamp: 150,
              turnTimeline: {
                id: 'artifact-turn-1',
                kind: 'artifact_ownership',
                timestamp: 150,
                tone: 'success',
                artifactOwnership: [
                  {
                    kind: 'file',
                    label: 'report.md',
                    ownerKind: 'tool',
                    ownerLabel: 'Write',
                    path: '/repo/app/report.md',
                  },
                ],
              },
            },
            {
              id: 'tool-write',
              type: 'tool_call',
              content: '',
              timestamp: 160,
              toolCall: {
                id: 'tool-write',
                name: 'Write',
                args: {},
                result: 'saved',
                success: true,
                metadata: {
                  artifact: {
                    artifactId: 'artifact-report',
                    kind: 'text',
                    sourceTool: 'Write',
                    createdAt: '2026-05-07T00:00:00.000Z',
                    name: 'report.md',
                    path: '/repo/app/report.md',
                  },
                  artifacts: [
                    {
                      artifactId: 'artifact-source',
                      kind: 'web',
                      sourceTool: 'web_fetch',
                      createdAt: '2026-05-07T00:00:01.000Z',
                      name: 'Source page',
                      url: 'https://example.com/source',
                    },
                  ],
                },
              },
            },
          ],
        },
      ],
    };

    expect(extractCurrentTurnArtifactOwnership(projection)?.artifactOwnership).toEqual([
      {
        kind: 'file',
        label: 'report.md',
        ownerKind: 'tool',
        ownerLabel: 'Write',
        path: '/repo/app/report.md',
      },
      {
        kind: 'link',
        label: 'Source page',
        ownerKind: 'tool',
        ownerLabel: 'web_fetch',
        url: 'https://example.com/source',
        sourceNodeId: 'tool-write',
      },
    ]);
  });
});
