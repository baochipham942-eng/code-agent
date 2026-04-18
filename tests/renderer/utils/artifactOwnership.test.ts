import { describe, expect, it } from 'vitest';
import type { TraceTurn } from '../../../src/shared/contract/trace';
import { buildArtifactOwnershipItems } from '../../../src/renderer/utils/artifactOwnership';

describe('buildArtifactOwnershipItems', () => {
  it('collects assistant artifacts and tool output files with owner labels', () => {
    const items = buildArtifactOwnershipItems({
      turnNumber: 1,
      turnId: 'turn-1',
      status: 'completed',
      startTime: 100,
      endTime: 140,
      nodes: [
        {
          id: 'user-1',
          type: 'user',
          content: '生成报告',
          timestamp: 100,
        },
        {
          id: 'assistant-1',
          type: 'assistant_text',
          content: '已生成图表',
          timestamp: 120,
          artifacts: [
            {
              id: 'artifact-1',
              type: 'chart',
              title: 'Execution Chart',
              content: '{}',
              version: 1,
            },
          ],
        },
        {
          id: 'tool-1',
          type: 'tool_call',
          content: '',
          timestamp: 130,
          toolCall: {
            id: 'tool-1',
            name: 'Write',
            args: {},
            result: 'ok',
            success: true,
            outputPath: '/repo/app/report.md',
            metadata: {
              imagePath: '/repo/app/preview.png',
            },
          },
        },
      ],
    } satisfies TraceTurn, {
      mode: 'direct',
      summary: 'Direct 已发送给 reviewer',
      agentNames: ['reviewer'],
      steps: [],
    });

    expect(items).toEqual([
      {
        kind: 'artifact',
        label: 'Execution Chart',
        ownerKind: 'assistant',
        ownerLabel: 'reviewer',
        sourceNodeId: 'assistant-1',
      },
      {
        kind: 'file',
        label: 'report.md',
        ownerKind: 'tool',
        ownerLabel: 'reviewer · Write',
        path: '/repo/app/report.md',
        sourceNodeId: 'tool-1',
      },
      {
        kind: 'file',
        label: 'preview.png',
        ownerKind: 'tool',
        ownerLabel: 'reviewer · Write',
        path: '/repo/app/preview.png',
        sourceNodeId: 'tool-1',
      },
    ]);
  });
});
