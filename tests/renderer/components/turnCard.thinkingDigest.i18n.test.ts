import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { TraceTurn } from '../../../src/shared/contract/trace';
import { en } from '../../../src/renderer/i18n/en';

// 真实 zustand store 在 renderToStaticMarkup（SSR）下不可靠地反映 setState 之后的语言切换
// （useSyncExternalStore 的 server snapshot 行为），所以这里直接 mock useI18n 强制英文，
// 只验证 ThinkingDigestBanner 有没有正确接线到 t.chat.* —— 而不是测试 store 本身的语言切换。
vi.mock('../../../src/renderer/hooks/useI18n', () => ({
  useI18n: () => ({ t: en, language: 'en' }),
}));

vi.mock('../../../src/renderer/components/features/chat/TraceNodeRenderer', () => ({
  TraceNodeRenderer: ({ node }: { node: { type: string; content?: string } }) => (
    React.createElement('div', null, node.content || node.type)
  ),
}));

vi.mock('../../../src/renderer/components/features/chat/StreamingIndicator', () => ({
  StreamingIndicator: () => null,
  getRunningToolStartTime: () => null,
}));

vi.mock('../../../src/renderer/components/features/chat/MessageBubble/TurnDiffSummary', () => ({
  TurnDiffSummary: () => null,
}));

vi.mock('../../../src/renderer/components/features/chat/ToolStepGroup', () => ({
  ToolStepGroup: () => React.createElement('div', null, 'tool group'),
}));

import { TurnCard } from '../../../src/renderer/components/features/chat/TurnCard';

describe('TurnCard — 思考折叠块 en 态接线（不中英混排）', () => {
  it('标题、段数计数、tooltip 全部走 t.chat.*，没有硬编码中文残留', () => {
    const turn: TraceTurn = {
      turnNumber: 1,
      turnId: 'turn-1',
      status: 'completed',
      startTime: 100,
      endTime: 900,
      nodes: [
        { id: 'user-1', type: 'user', content: 'hi', timestamp: 100 },
        {
          id: 'a-0-text', type: 'assistant_text', content: '', timestamp: 200,
          thinking: 'first thought segment.',
        } as TraceTurn['nodes'][number],
        {
          id: 'a-0-tc', type: 'tool_call', content: '', timestamp: 201,
          toolCall: { id: 'c0', name: 'Bash', args: {}, success: true, result: 'ok' },
        } as TraceTurn['nodes'][number],
        {
          id: 'a-1-text', type: 'assistant_text', content: '', timestamp: 210,
          thinking: 'second thought segment.',
        } as TraceTurn['nodes'][number],
        {
          id: 'a-1-tc', type: 'tool_call', content: '', timestamp: 211,
          toolCall: { id: 'c1', name: 'Bash', args: {}, success: true, result: 'ok' },
        } as TraceTurn['nodes'][number],
        { id: 'a-final', type: 'assistant_text', content: 'final answer', timestamp: 900 } as TraceTurn['nodes'][number],
      ],
    };

    const html = renderToStaticMarkup(React.createElement(TurnCard, { turn, defaultExpanded: true }));

    expect(html).toContain('Thinking · 2 segments');
    expect(html).toContain('title="Expand thinking"');
    expect(html).not.toContain('思考');
    expect(html).not.toContain('展开思考');
    expect(html).not.toContain('收起思考');
  });
});
