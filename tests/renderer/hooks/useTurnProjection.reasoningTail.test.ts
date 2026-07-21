// ============================================================================
// 活动轮思考尾置 — 2026-07-21 真机视频闪烁根因修复
// 流式期间 reasoning 挂轮首会让增长发生在视口中部（工具卡上方），钉底滚动下
// 上方整块逐行上跳。活动轮 reasoning 必须搬到轮尾 live 节点；完成轮保持
// 「思考先于工具」历史布局不变。
// ============================================================================

import { describe, expect, it } from 'vitest';
import type { Message } from '../../../src/shared/contract';
import { projectTurns } from '../../../src/renderer/hooks/useTurnProjection';
import { getReasoningLiveNodeId } from '../../../src/renderer/utils/streamingProjectionOverlay';

function buildMessages(): Message[] {
  return [
    { id: 'user-1', role: 'user', content: '整理股票复盘报告', timestamp: 100 },
    {
      id: 'turn-draft-1',
      role: 'assistant',
      content: 'Let me look at the component.',
      reasoning: 'So it reads investmentAdviser first...',
      timestamp: 150,
      toolCalls: [
        {
          id: 'tc-1',
          name: 'Read',
          arguments: { file_path: 'a.ts' },
          result: { toolCallId: 'tc-1', success: true, output: 'ok', duration: 10 },
        },
      ],
      contentParts: [
        { type: 'text', text: 'Let me look at the component.' },
        { type: 'tool_call', toolCallId: 'tc-1' },
      ],
    },
  ];
}

describe('projectTurns 活动轮思考尾置', () => {
  it('流式轮：reasoning 从首文本节点搬到轮尾 live 节点', () => {
    const projection = projectTurns(buildMessages(), 'session-1', true, []);
    const turn = projection.turns[projection.activeTurnIndex];
    expect(turn).toBeDefined();

    const lastNode = turn.nodes[turn.nodes.length - 1];
    expect(lastNode.id).toBe(getReasoningLiveNodeId('turn-draft-1'));
    expect(lastNode.reasoning).toContain('investmentAdviser');

    // 首文本节点不再携带 reasoning（防重复渲染）
    const firstTextNode = turn.nodes.find((node) => node.id === 'turn-draft-1-text');
    expect(firstTextNode?.reasoning).toBeUndefined();
  });

  it('完成轮：保持「思考先于工具」，不迁移', () => {
    const projection = projectTurns(buildMessages(), 'session-1', false, []);
    const turn = projection.turns[projection.turns.length - 1];
    const lastNode = turn.nodes[turn.nodes.length - 1];
    expect(lastNode.id).not.toBe(getReasoningLiveNodeId('turn-draft-1'));

    const firstTextNode = turn.nodes.find((node) => node.id === 'turn-draft-1-text');
    expect(firstTextNode?.reasoning).toContain('investmentAdviser');
  });

  it('活动轮但 reasoning 已在尾部（无尾随节点）：不迁移不新增节点', () => {
    const messages: Message[] = [
      { id: 'user-1', role: 'user', content: 'hi', timestamp: 100 },
      {
        id: 'turn-draft-1',
        role: 'assistant',
        content: '',
        reasoning: 'thinking...',
        timestamp: 150,
      },
    ];
    const projection = projectTurns(messages, 'session-1', true, []);
    const turn = projection.turns[projection.activeTurnIndex];
    expect(turn.nodes.some((node) => node.id === getReasoningLiveNodeId('turn-draft-1'))).toBe(false);
  });

  it('纯思考承载节点（空正文）搬空后不留空壳', () => {
    const messages: Message[] = [
      { id: 'user-1', role: 'user', content: 'hi', timestamp: 100 },
      {
        id: 'turn-draft-1',
        role: 'assistant',
        content: '',
        reasoning: 'thinking before tools',
        timestamp: 150,
        toolCalls: [
          {
            id: 'tc-1',
            name: 'Read',
            arguments: {},
            result: { toolCallId: 'tc-1', success: true, output: 'ok', duration: 5 },
          },
        ],
        contentParts: [{ type: 'tool_call', toolCallId: 'tc-1' }],
      },
    ];
    const projection = projectTurns(messages, 'session-1', true, []);
    const turn = projection.turns[projection.activeTurnIndex];
    const emptyCarriers = turn.nodes.filter(
      (node) => node.type === 'assistant_text' && node.content === '' && !node.reasoning && !node.thinking,
    );
    expect(emptyCarriers).toHaveLength(0);
    const lastNode = turn.nodes[turn.nodes.length - 1];
    expect(lastNode.id).toBe(getReasoningLiveNodeId('turn-draft-1'));
    expect(lastNode.reasoning).toBe('thinking before tools');
  });
});
