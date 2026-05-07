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

  it('collects unified tool artifact metadata with stable labels, kinds, and dedupe', () => {
    const items = buildArtifactOwnershipItems({
      turnNumber: 2,
      turnId: 'turn-2',
      status: 'completed',
      startTime: 200,
      endTime: 260,
      nodes: [
        {
          id: 'tool-2',
          type: 'tool_call',
          content: '',
          timestamp: 230,
          toolCall: {
            id: 'tool-2',
            name: 'WebFetch',
            args: {},
            result: 'ok',
            success: true,
            outputPath: '/repo/app/report.md',
            metadata: {
              filePath: '/repo/app/report.md',
              artifact: {
                artifactId: 'artifact-image',
                kind: 'image',
                sourceTool: 'image_generate',
                name: 'Hero preview',
                path: '/repo/app/hero.png',
              },
              artifacts: [
                {
                  artifactId: 'artifact-web',
                  kind: 'web',
                  sourceTool: 'WebFetch',
                  name: 'Spec page',
                  url: 'https://example.com/spec',
                },
                {
                  artifactId: 'artifact-image-duplicate',
                  kind: 'image',
                  sourceTool: 'image_generate',
                  name: 'Duplicate hero',
                  path: '/repo/app/hero.png',
                },
                {
                  artifactId: 'artifact-task',
                  kind: 'text',
                  sourceTool: 'Task',
                  name: 'Task result',
                  preview: 'done',
                },
              ],
            },
          },
        },
      ],
    } satisfies TraceTurn);

    expect(items).toEqual([
      {
        kind: 'file',
        label: 'report.md',
        ownerKind: 'tool',
        ownerLabel: 'WebFetch',
        path: '/repo/app/report.md',
        sourceNodeId: 'tool-2',
      },
      {
        kind: 'file',
        label: 'Hero preview',
        ownerKind: 'tool',
        ownerLabel: 'image_generate',
        path: '/repo/app/hero.png',
        url: undefined,
        sourceNodeId: 'tool-2',
      },
      {
        kind: 'link',
        label: 'Spec page',
        ownerKind: 'tool',
        ownerLabel: 'WebFetch',
        path: undefined,
        url: 'https://example.com/spec',
        sourceNodeId: 'tool-2',
      },
      {
        kind: 'artifact',
        label: 'Task result',
        ownerKind: 'tool',
        ownerLabel: 'Task',
        path: undefined,
        url: undefined,
        sourceNodeId: 'tool-2',
      },
    ]);
  });

  it('caps unified tool artifact metadata before projecting ownership items', () => {
    const items = buildArtifactOwnershipItems({
      turnNumber: 3,
      turnId: 'turn-3',
      status: 'completed',
      startTime: 300,
      endTime: 360,
      nodes: [
        {
          id: 'tool-3',
          type: 'tool_call',
          content: '',
          timestamp: 330,
          toolCall: {
            id: 'tool-3',
            name: 'BulkTool',
            args: {},
            result: 'ok',
            success: true,
            metadata: {
              artifacts: Array.from({ length: 20 }, (_, index) => ({
                artifactId: `artifact-${index}`,
                kind: 'text',
                sourceTool: 'BulkTool',
                name: `Artifact ${index}`,
              })),
            },
          },
        },
      ],
    } satisfies TraceTurn);

    expect(items).toHaveLength(12);
    expect(items[0]?.label).toBe('Artifact 0');
    expect(items[11]?.label).toBe('Artifact 11');
  });
});
