import { describe, expect, it } from 'vitest';
import type { TraceTurn } from '../../../src/shared/contract/trace';
import {
  buildArtifactOwnershipItems,
  isReadOnlyArtifactTool,
} from '../../../src/renderer/utils/artifactOwnership';

describe('buildArtifactOwnershipItems', () => {
  it('同一路径 outputPath 与工具 artifact 去重时保留 sha/size/mime 实证', () => {
    const items = buildArtifactOwnershipItems({
      turnNumber: 1,
      turnId: 'turn-file-evidence',
      status: 'completed',
      startTime: 100,
      endTime: 120,
      nodes: [{
        id: 'tool-write',
        type: 'tool_call',
        content: '',
        timestamp: 110,
        toolCall: {
          id: 'tool-write',
          name: 'ArtifactWriter',
          args: {},
          result: 'ok',
          success: true,
          outputPath: '/repo/report.md',
          metadata: {
            artifact: {
              artifactId: 'artifact-report',
              kind: 'document',
              sourceTool: 'ArtifactWriter',
              name: 'report.md',
              path: '/repo/report.md',
              sha256: 'b'.repeat(64),
              sizeBytes: 128,
              mimeType: 'text/markdown',
            },
          },
        },
      }],
    } satisfies TraceTurn);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      path: '/repo/report.md',
      fileMetadata: {
        sha256: 'b'.repeat(64),
        sizeBytes: 128,
        mimeType: 'text/markdown',
      },
    });
  });

  it('collects assistant artifacts and non-diff metadata files with owner labels', () => {
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
        // 角色轴（ADR-055）：模型显式创建的 artifact 本身就是交付物
        role: 'deliverable',
        label: 'Execution Chart',
        ownerKind: 'assistant',
        ownerLabel: 'reviewer',
        sourceNodeId: 'assistant-1',
      },
      {
        // N-DELIVCARD（2026-08-18 爸拍板）：交付物即便同时进了本轮 diff 也留在产物区，
        // 去重改由 TurnDiffSummary 的 excludedFilePaths 在 diff 卡那侧完成。
        kind: 'file',
        role: 'deliverable',
        label: 'report.md',
        ownerKind: 'tool',
        ownerLabel: 'reviewer · Write',
        path: '/repo/app/report.md',
        sourceNodeId: 'tool-1',
      },
      {
        kind: 'file',
        role: 'deliverable',
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
        // outputPath 是工具声明的产出，恒 deliverable（ADR-055）
        role: 'deliverable',
        label: 'report.md',
        ownerKind: 'tool',
        ownerLabel: 'WebFetch',
        path: '/repo/app/report.md',
        sourceNodeId: 'tool-2',
      },
      {
        kind: 'file',
        role: 'deliverable', // kind=image → deliverable
        label: 'Hero preview',
        ownerKind: 'tool',
        ownerLabel: 'image_generate',
        path: '/repo/app/hero.png',
        url: undefined,
        sourceNodeId: 'tool-2',
      },
      {
        kind: 'link',
        // kind=web → material：抓取的页面是过程材料，降级进「来源」区不进产物
        role: 'material',
        label: 'Spec page',
        ownerKind: 'tool',
        ownerLabel: 'WebFetch',
        path: undefined,
        url: 'https://example.com/spec',
        sourceNodeId: 'tool-2',
      },
    ]);
  });

  // 2026-08-18（爸拍板，N-DELIVCARD）：去重不变量「同一文件不出现两张卡」不变，但**赢家换成产物卡**。
  // 此前是产物条目让位给 diff 卡，导致用户要的网页只显示「+243 行」这种程序员语言（Neo 是 cowork
  // 产品、产物为主轴，呈现反了）。现在 deliverable 保留在产物区，改由 TurnDiffSummary 的
  // excludedFilePaths 把它从轮级 diff 卡排除（对侧用例见 turnDiffSummary.expansion.test.tsx
  // 「由产物卡承接的文件不再另起轮级 diff 卡」）。非 deliverable 仍按旧规则让位。
  it('keeps deliverables in the artifact list even when the turn diff summary covers them', () => {
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
            name: 'Write',
            args: {
              path: '/repo/app/report.md',
              content: '# Report\n\nDone',
            },
            result: 'Created file: /repo/app/report.md',
            success: true,
            outputPath: '/repo/app/report.md',
            metadata: {
              filePath: '/repo/app/report.md',
              imagePath: '/repo/app/chart.png',
            },
          },
        },
      ],
    } satisfies TraceTurn);

    expect(items).toEqual([
      {
        kind: 'file',
        role: 'deliverable',
        label: 'report.md',
        ownerKind: 'tool',
        ownerLabel: 'Write',
        path: '/repo/app/report.md',
        sourceNodeId: 'tool-2',
      },
      {
        kind: 'file',
        role: 'deliverable',
        label: 'chart.png',
        ownerKind: 'tool',
        ownerLabel: 'Write',
        path: '/repo/app/chart.png',
        sourceNodeId: 'tool-2',
      },
    ]);
  });

  it('keeps process output and process logs out of the deliverable artifact list', () => {
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
            name: 'Bash',
            args: {},
            result: 'ok',
            success: true,
            metadata: {
              artifacts: [
                {
                  artifactId: 'artifact-bash-output',
                  kind: 'process-output',
                  sourceTool: 'Bash',
                  name: 'Bash output',
                  preview: 'npm test output',
                },
                {
                  artifactId: 'artifact-bash-log',
                  kind: 'process-log',
                  sourceTool: 'Bash',
                  name: 'Bash log',
                  path: '/tmp/code-agent/bash-output.log',
                },
                {
                  artifactId: 'artifact-preview',
                  kind: 'html',
                  sourceTool: 'Write',
                  name: 'Preview',
                  path: '/repo/app/preview.html',
                },
              ],
            },
          },
        },
      ],
    } satisfies TraceTurn);

    // ADR-055 起本函数返回**带 role 的全集**，交付/材料的分流由消费端按 role 做。
    // 所以这里断言的不再是「process 输出不在返回值里」，而是更强的一条：
    // 它们即便被返回，也一律带 role='material'，永远进不了产物区。
    expect(items.filter((i) => i.role === 'deliverable')).toEqual([
      {
        kind: 'file',
        role: 'deliverable',
        label: 'Preview',
        ownerKind: 'tool',
        ownerLabel: 'Write',
        path: '/repo/app/preview.html',
        url: undefined,
        sourceNodeId: 'tool-3',
      },
    ]);
    expect(items.filter((i) => i.role !== 'material').map((i) => i.label)).toEqual(['Preview']);
  });

  it('keeps MemoryRead files out of the deliverable artifact list', () => {
    expect(isReadOnlyArtifactTool('MemoryRead')).toBe(true);

    const items = buildArtifactOwnershipItems({
      turnNumber: 4,
      turnId: 'turn-4',
      status: 'completed',
      startTime: 400,
      endTime: 440,
      nodes: [
        {
          id: 'memory-read',
          type: 'tool_call',
          content: '',
          timestamp: 420,
          toolCall: {
            id: 'memory-read',
            name: 'MemoryRead',
            args: { filename: 'soul.md' },
            result: 'memory content',
            success: true,
            metadata: {
              filename: 'soul.md',
              path: '/Users/linchen/.codex/memories/soul.md',
              artifact: {
                artifactId: 'artifact-memory-soul',
                kind: 'text',
                sourceTool: 'MemoryRead',
                name: 'soul.md',
                path: '/Users/linchen/.codex/memories/soul.md',
              },
            },
          },
        },
      ],
    } satisfies TraceTurn);

    // 同上：MemoryRead 的读取内容（kind=text ⇒ material）不再从返回值里消失，
    // 而是带 role='material' 返回。产物区一条都不该有。
    // （UI 层另有 isReadOnlyArtifactOwnershipItem 过滤，只读工具的材料连「来源」区也不摆。）
    expect(items.filter((i) => i.role === 'deliverable')).toEqual([]);
    expect(items.every((i) => i.role === 'material')).toBe(true);
  });

  it('caps unified tool artifact metadata before projecting ownership items', () => {
    const items = buildArtifactOwnershipItems({
      turnNumber: 4,
      turnId: 'turn-4',
      status: 'completed',
      startTime: 400,
      endTime: 460,
      nodes: [
        {
          id: 'tool-4',
          type: 'tool_call',
          content: '',
          timestamp: 430,
          toolCall: {
            id: 'tool-4',
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
                path: `/repo/app/artifact-${index}.md`,
              })),
            },
          },
        },
      ],
    } satisfies TraceTurn);

    expect(items).toHaveLength(12);
    expect(items[0]?.label).toBe('Artifact 0');
    expect(items[11]?.label).toBe('Artifact 11');
    expect(items[11]?.path).toBe('/repo/app/artifact-11.md');
  });

  it('相对与绝对路径写同一文件，工作目录已知时折叠为一条（先写法保留）', () => {
    const items = buildArtifactOwnershipItems({
      turnNumber: 5,
      turnId: 'turn-relabs',
      status: 'completed',
      startTime: 500,
      endTime: 560,
      nodes: [
        {
          id: 'tool-rel',
          type: 'tool_call',
          content: '',
          timestamp: 510,
          toolCall: {
            id: 'tool-rel',
            name: 'Write',
            args: { file_path: './report.html' },
            result: 'ok',
            success: true,
            outputPath: './report.html',
          },
        },
        {
          id: 'tool-abs',
          type: 'tool_call',
          content: '',
          timestamp: 520,
          toolCall: {
            id: 'tool-abs',
            name: 'Write',
            args: { file_path: '/demo/work/report.html' },
            result: 'ok',
            success: true,
            outputPath: '/demo/work/report.html',
          },
        },
      ],
    } satisfies TraceTurn, undefined, '/demo/work');

    expect(items).toHaveLength(1);
    // 键折叠的是「同一文件」；条目本身的 path 保持第一次出现的写法（展示不变）。
    expect(items[0]).toMatchObject({
      path: './report.html',
      sourceNodeId: 'tool-rel',
      ownerLabel: 'Write',
    });
  });

  it('无工作目录时相对与绝对写法不合并（不猜基准）', () => {
    const items = buildArtifactOwnershipItems({
      turnNumber: 5,
      turnId: 'turn-relabs-nowd',
      status: 'completed',
      startTime: 500,
      endTime: 560,
      nodes: [
        {
          id: 'tool-rel',
          type: 'tool_call',
          content: '',
          timestamp: 510,
          toolCall: {
            id: 'tool-rel',
            name: 'Write',
            args: { file_path: './report.html' },
            result: 'ok',
            success: true,
            outputPath: './report.html',
          },
        },
        {
          id: 'tool-abs',
          type: 'tool_call',
          content: '',
          timestamp: 520,
          toolCall: {
            id: 'tool-abs',
            name: 'Write',
            args: { file_path: '/demo/work/report.html' },
            result: 'ok',
            success: true,
            outputPath: '/demo/work/report.html',
          },
        },
      ],
    } satisfies TraceTurn);

    expect(items).toHaveLength(2);
    expect(items.map((item) => item.path)).toEqual(['./report.html', '/demo/work/report.html']);
  });

  it('无工作目录时 ./ 与裸相对写法仍折叠（词法清理不依赖基准）', () => {
    const items = buildArtifactOwnershipItems({
      turnNumber: 6,
      turnId: 'turn-dotted',
      status: 'completed',
      startTime: 600,
      endTime: 660,
      nodes: [
        {
          id: 'tool-dotted',
          type: 'tool_call',
          content: '',
          timestamp: 610,
          toolCall: {
            id: 'tool-dotted',
            name: 'Write',
            args: { file_path: './a.html' },
            result: 'ok',
            success: true,
            outputPath: './a.html',
          },
        },
        {
          id: 'tool-bare',
          type: 'tool_call',
          content: '',
          timestamp: 620,
          toolCall: {
            id: 'tool-bare',
            name: 'Write',
            args: { file_path: 'a.html' },
            result: 'ok',
            success: true,
            outputPath: 'a.html',
          },
        },
      ],
    } satisfies TraceTurn);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ path: './a.html', sourceNodeId: 'tool-dotted' });
  });

  it('../ 相对写法经词法清理后与同一文件的绝对路径折叠', () => {
    const items = buildArtifactOwnershipItems({
      turnNumber: 7,
      turnId: 'turn-dotdot',
      status: 'completed',
      startTime: 700,
      endTime: 760,
      nodes: [
        {
          id: 'tool-dotdot',
          type: 'tool_call',
          content: '',
          timestamp: 710,
          toolCall: {
            id: 'tool-dotdot',
            name: 'Write',
            args: { file_path: '../out/report.html' },
            result: 'ok',
            success: true,
            outputPath: '../out/report.html',
          },
        },
        {
          id: 'tool-abs',
          type: 'tool_call',
          content: '',
          timestamp: 720,
          toolCall: {
            id: 'tool-abs',
            name: 'Write',
            args: { file_path: '/demo/out/report.html' },
            result: 'ok',
            success: true,
            outputPath: '/demo/out/report.html',
          },
        },
      ],
    } satisfies TraceTurn, undefined, '/demo/work');

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ path: '../out/report.html', sourceNodeId: 'tool-dotdot' });
  });

  it('同名文件在不同目录，工作目录已知时仍保持两条', () => {
    const items = buildArtifactOwnershipItems({
      turnNumber: 8,
      turnId: 'turn-samebase',
      status: 'completed',
      startTime: 800,
      endTime: 860,
      nodes: [
        {
          id: 'tool-a',
          type: 'tool_call',
          content: '',
          timestamp: 810,
          toolCall: {
            id: 'tool-a',
            name: 'Write',
            args: { file_path: 'a/index.html' },
            result: 'ok',
            success: true,
            outputPath: 'a/index.html',
          },
        },
        {
          id: 'tool-b',
          type: 'tool_call',
          content: '',
          timestamp: 820,
          toolCall: {
            id: 'tool-b',
            name: 'Write',
            args: { file_path: 'b/index.html' },
            result: 'ok',
            success: true,
            outputPath: 'b/index.html',
          },
        },
      ],
    } satisfies TraceTurn, undefined, '/demo/work');

    expect(items).toHaveLength(2);
    expect(items.map((item) => item.path)).toEqual(['a/index.html', 'b/index.html']);
  });
});
