// ============================================================================
// 活动轮思考顺序稳定 — 2026-08-26
// 流式与终态共用同一节点顺序，不再为贴底滚动创建 reasoning-live 节点。
// ============================================================================

import { describe, expect, it } from 'vitest';
import type { Message } from '../../../src/shared/contract';
import { projectTurns } from '../../../src/renderer/hooks/useTurnProjection';

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

describe('projectTurns 活动轮思考顺序稳定', () => {
  it('流式轮：reasoning 留在原消息承载节点', () => {
    const projection = projectTurns(buildMessages(), 'session-1', true, []);
    const turn = projection.turns[projection.activeTurnIndex];
    expect(turn).toBeDefined();

    const firstTextNode = turn.nodes.find((node) => node.id === 'turn-draft-1-text');
    expect(firstTextNode?.reasoning).toContain('investmentAdviser');
    expect(turn.nodes.some((node) => node.id === 'turn-draft-1-reasoning-live')).toBe(false);
  });

  it('完成轮：保持「思考先于工具」，不迁移', () => {
    const projection = projectTurns(buildMessages(), 'session-1', false, []);
    const turn = projection.turns[projection.turns.length - 1];
    const firstTextNode = turn.nodes.find((node) => node.id === 'turn-draft-1-text');
    expect(firstTextNode?.reasoning).toContain('investmentAdviser');
  });

  it('无尾随节点的 reasoning 同样不新增节点', () => {
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
    expect(turn.nodes.some((node) => node.id === 'turn-draft-1-reasoning-live')).toBe(false);
  });

  it('纯思考承载节点（空正文）保留事件位置', () => {
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
    const carrier = turn.nodes.find((node) => node.id === 'turn-draft-1-text');
    expect(carrier?.reasoning).toBe('thinking before tools');
    expect(turn.nodes.map((node) => node.id)).toEqual([
      'user-1',
      'turn-draft-1-text',
      'turn-draft-1-tc-tc-1',
    ]);
  });
});
