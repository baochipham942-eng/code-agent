// 概览四模块 · 模块四产物条目生成门槛（spec §模块四，工单 C.12）：
// 参数校验失败 / 执行失败的工具调用不生成产物条目——trace 实证：幻觉工具
// "Blob" 的失败调用生成了带 "Blob" 标签的裂图卡。

import { describe, expect, it } from 'vitest';
import type { Message } from '../../../src/shared/contract';
import type { TraceTurn } from '../../../src/shared/contract/trace';
import { buildArtifactOwnershipItems } from '../../../src/renderer/utils/artifactOwnership';
import { buildWorkspacePreviewItems } from '../../../src/renderer/utils/workspacePreview';

function turnWithToolCall(toolCall: NonNullable<TraceTurn['nodes'][number]['toolCall']>): TraceTurn {
  return {
    turnNumber: 1,
    turnId: 'turn-1',
    status: 'completed',
    startTime: 100,
    endTime: 140,
    nodes: [
      { id: 'user-1', type: 'user', content: '生成图片', timestamp: 100 },
      { id: 'tool-1', type: 'tool_call', content: '', timestamp: 120, toolCall },
    ],
  };
}

describe('产物条目生成门槛：失败调用不建条目', () => {
  it('执行失败的工具调用（success=false）不产生 ownership 条目', () => {
    const items = buildArtifactOwnershipItems(turnWithToolCall({
      id: 'tool-1',
      name: 'Blob',
      args: {},
      result: '参数校验失败：unknown tool',
      success: false,
      outputPath: '/repo/app/broken.png',
      metadata: { imagePath: '/repo/app/broken.png' },
    }));

    expect(items).toEqual([]);
  });

  it('同一轮里失败调用不建条目、成功调用照常建', () => {
    const turn = turnWithToolCall({
      id: 'tool-fail',
      name: 'image_generate',
      args: {},
      result: 'validation failed',
      success: false,
      metadata: { imagePath: '/repo/app/fail.png' },
    });
    turn.nodes.push({
      id: 'tool-ok',
      type: 'tool_call',
      content: '',
      timestamp: 130,
      toolCall: {
        id: 'tool-ok',
        name: 'image_generate',
        args: {},
        result: 'ok',
        success: true,
        metadata: { imagePath: '/repo/app/ok.png' },
      },
    });

    const items = buildArtifactOwnershipItems(turn);

    expect(items.map((item) => item.path)).toEqual(['/repo/app/ok.png']);
  });

  it('失败调用不产生 workspace 预览条目（含 metadata 里的图片路径）', () => {
    const messages: Message[] = [
      {
        id: 'msg-1',
        role: 'assistant',
        content: '',
        timestamp: 200,
        toolCalls: [
          {
            id: 'tool-1',
            name: 'Blob',
            arguments: {},
            result: {
              toolCallId: 'tool-1',
              success: false,
              output: 'validation failed',
              metadata: { imagePath: '/repo/app/broken.png' },
            },
          },
        ],
      },
    ];

    const items = buildWorkspacePreviewItems({ messages, workingDirectory: '/repo/app' });

    expect(items).toEqual([]);
  });
});
