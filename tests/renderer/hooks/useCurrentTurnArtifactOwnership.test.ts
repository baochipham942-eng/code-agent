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
});
